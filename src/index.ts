import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  type ButtonInteraction,
  GatewayIntentBits,
  type Message,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type ThreadChannel
} from "discord.js";
import { saveDiscordAttachments, formatAttachmentPrompt, type AttachmentSaveResult } from "./attachments";
import { runCodex } from "./codex";
import { findLatestCodexSessionIdForWorkspace } from "./codexSessions";
import { loadConfig } from "./config";
import {
  editDiscordMessage,
  replyToInteraction,
  sendThreadMessage,
  sendThreadTyping
} from "./discordApi";
import {
  formatCodexResponse,
  formatControlPanelEmbed,
  formatError,
  formatQueueEmbed,
  formatRunCompleteEmbed,
  formatRunFailedEmbed,
  formatRunStartEmbed,
  formatRunStoppedEmbed,
  formatSettingsEmbed,
  formatStatusEmbed,
  formatWorkspaceEmbed,
  prefixChunks,
  shouldSendAsFile,
  splitDiscordMessage,
  summarizeLongResponse
} from "./discordFormat";
import { t } from "./i18n";
import { isStatusQuestion } from "./statusQuestions";
import { formatCommandHelp, parseThreadCommand, type ThreadCommand } from "./threadCommands";
import {
  cleanStaleWorkspaces,
  ensureThreadWorkspace,
  getWorkspaceStats,
  loadSessionState,
  markJobInterrupted,
  resetSession,
  saveJobState,
  saveSessionId,
  type ThreadWorkspace
} from "./workspaces";

interface QueuedJob {
  id: string;
  messages: Message[];
  prompt: string;
  promptSummary: string;
  authorId: string;
  authorName: string;
  createdAt: number;
  messageIds: string[];
  attachmentCount: number;
}

interface RunningJob {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  phase: string;
  lastEvent: string;
  timeoutAt?: number;
  idleDeadlineAt?: number;
  abortController: AbortController;
  statusMessage?: Message;
  stopRequested?: boolean;
  workspace?: ThreadWorkspace;
  job: QueuedJob;
}

interface ThreadState {
  queue: QueuedJob[];
  running?: RunningJob;
  selectedQueueJobId?: string;
}

interface ThreadSettings {
  model: string;
  reasoningEffort: string;
  hideWorkspacePaths: boolean;
  includeAttachments: boolean;
}

interface EnqueueResult {
  started: boolean;
  queued: number;
}

const config = loadConfig();
const messages = t(config.language);
const threadStates = new Map<string, ThreadState>();
const retryableJobs = new Map<string, QueuedJob>();
const threadSettings = new Map<string, ThreadSettings>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Watching guild ${config.discordGuildId}, parent channel ${config.discordParentChannelId}`);
  if (isAllowlistOpen()) {
    console.warn(messages.allowlistWarning);
  }
});

client.on(Events.ThreadCreate, async (thread) => {
  if (!isManagedThread(thread)) {
    return;
  }

  try {
    await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    await sendControlPanel(thread, threadStates.get(thread.id));
    console.log(`Prepared workspace for thread ${thread.id}`);
  } catch (error) {
    console.error(`Failed to prepare workspace for thread ${thread.id}`, error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!shouldHandleMessage(message)) {
    return;
  }

  const thread = message.channel as ThreadChannel;
  const prompt = message.cleanContent.trim();
  await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);

  if (!(await isAllowed(message))) {
    await sendThreadMessage(thread, {
      content: messages.denied,
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "message.denied", threadId: thread.id });
    return;
  }
  await notifyInterruptedIfAny(thread);

  const command = parseThreadCommand(prompt);
  if (command) {
    await handleThreadCommand(thread, command);
    return;
  }

  if (!prompt && message.attachments.size === 0) {
    return;
  }

  const state = threadStates.get(thread.id);
  if (state?.running && isStatusQuestion(prompt)) {
    await sendThreadStatus(thread, state);
    return;
  }

  const enqueueResult = enqueueThreadJob(thread.id, createQueuedJob([message], prompt));

  if (!enqueueResult.started) {
    await sendThreadStatus(thread, threadStates.get(thread.id));
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.guild || !interaction.channel?.isThread()) {
    return;
  }
  const thread = interaction.channel as ThreadChannel;
  if (!isManagedThread(thread)) {
    return;
  }
  if (!(await isInteractionAllowed(interaction))) {
    await replyToInteraction(interaction, { content: messages.denied, ephemeral: true }, discordApiOptions(), {
      action: "interaction.denied",
      threadId: thread.id
    });
    return;
  }
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction, thread);
    return;
  }
  await handleSelectMenuInteraction(interaction, thread);
});

await client.login(config.discordToken);

function shouldHandleMessage(message: Message): boolean {
  if (message.author.bot) {
    return false;
  }

  if (!message.guild || message.guild.id !== config.discordGuildId) {
    return false;
  }

  if (!message.channel.isThread()) {
    return false;
  }

  return isManagedThread(message.channel);
}

function isManagedThread(thread: ThreadChannel): boolean {
  return (
    thread.guildId === config.discordGuildId &&
    thread.parentId === config.discordParentChannelId &&
    [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread
    ].includes(thread.type)
  );
}

async function isAllowed(message: Message): Promise<boolean> {
  return isUserAllowed(message.guild, message.author.id, message.member);
}

async function isInteractionAllowed(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  return isUserAllowed(interaction.guild, interaction.user.id, interaction.member);
}

async function isUserAllowed(
  guild: Message["guild"],
  userId: string,
  memberLike: Message["member"] | ButtonInteraction["member"] | StringSelectMenuInteraction["member"]
): Promise<boolean> {
  if (config.allowedUserIds.length === 0 && config.allowedRoleIds.length === 0) {
    return true;
  }

  if (config.allowedUserIds.includes(userId)) {
    return true;
  }

  const member = memberLike && "roles" in memberLike
    ? memberLike
    : (await guild?.members.fetch(userId).catch(() => null));
  if (!member) {
    return false;
  }

  const roles = member.roles;
  if (Array.isArray(roles)) {
    return config.allowedRoleIds.some((roleId) => roles.includes(roleId));
  }
  return config.allowedRoleIds.some((roleId) => roles.cache.has(roleId));
}

function createQueuedJob(messages: Message[], prompt: string): QueuedJob {
  const latestMessage = messages[messages.length - 1];
  const author = latestMessage?.author;
  return {
    id: createJobId(),
    messages,
    prompt,
    promptSummary: summarizePrompt(prompt),
    authorId: author?.id ?? "unknown",
    authorName: latestMessage?.member?.displayName ?? author?.username ?? "unknown",
    createdAt: Date.now(),
    messageIds: messages.map((message) => message.id),
    attachmentCount: messages.reduce((count, message) => count + message.attachments.size, 0)
  };
}

function createJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function summarizePrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return messages.analyzeAttachments;
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function getThreadState(threadId: string): ThreadState {
  const existing = threadStates.get(threadId);
  if (existing) {
    return existing;
  }

  const created: ThreadState = { queue: [] };
  threadStates.set(threadId, created);
  return created;
}

function getThreadSettings(threadId: string): ThreadSettings {
  const existing = threadSettings.get(threadId);
  if (existing) {
    return existing;
  }

  const created: ThreadSettings = {
    model: config.codexModel,
    reasoningEffort: config.codexReasoningEffort,
    hideWorkspacePaths: config.hideWorkspacePaths,
    includeAttachments: true
  };
  threadSettings.set(threadId, created);
  return created;
}

function enqueueThreadJob(threadId: string, job: QueuedJob): EnqueueResult {
  const state = getThreadState(threadId);
  state.queue.push(job);

  if (state.running) {
    return {
      started: false,
      queued: state.queue.length
    };
  }

  void processNextJob(threadId);
  return {
    started: true,
    queued: state.queue.length
  };
}

function mergeQueuedJobs(jobs: QueuedJob[]): QueuedJob {
  if (jobs.length === 1) {
    return jobs[0];
  }

  const first = jobs[0];
  return {
    id: first.id,
    messages: jobs.flatMap((job) => job.messages),
    authorId: first.authorId,
    authorName: first.authorName,
    createdAt: first.createdAt,
    messageIds: jobs.flatMap((job) => job.messageIds),
    attachmentCount: jobs.reduce((count, job) => count + job.attachmentCount, 0),
    promptSummary: jobs.map((job) => job.promptSummary).join(" / ").slice(0, 120),
    prompt: [
      messages.combinedPromptIntro,
      ...jobs.map((job, index) => {
        const prompt = job.prompt.trim() || messages.analyzeAttachments;
        return [
          `\n[${index + 1}]`,
          `Author: ${job.authorName} (${job.authorId})`,
          `Messages: ${job.messageIds.join(", ")}`,
          `Created: ${new Date(job.createdAt).toISOString()}`,
          `Attachments: ${job.attachmentCount}`,
          prompt
        ].join("\n");
      })
    ].join("\n")
  };
}

async function processNextJob(threadId: string): Promise<void> {
  const state = getThreadState(threadId);
  if (state.running) {
    return;
  }

  const firstJob = state.queue.shift();
  if (!firstJob) {
    if (state.queue.length === 0) {
      threadStates.delete(threadId);
    }
    return;
  }
  const job = mergeQueuedJobs([firstJob, ...state.queue.splice(0)]);

  const abortController = new AbortController();
  state.running = {
    id: job.id,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    phase: "preparing",
    lastEvent: "Job accepted.",
    timeoutAt: config.codexRunTimeoutMs ? Date.now() + config.codexRunTimeoutMs : undefined,
    idleDeadlineAt: config.codexIdleTimeoutMs ? Date.now() + config.codexIdleTimeoutMs : undefined,
    abortController,
    job
  };

  try {
    await handleThreadPrompt(job, state);
  } finally {
    state.running = undefined;
    if (state.queue.length > 0) {
      void processNextJob(threadId);
    } else {
      threadStates.delete(threadId);
    }
  }
}

async function handleThreadPrompt(job: QueuedJob, state: ThreadState): Promise<void> {
  const latestMessage = job.messages[job.messages.length - 1];
  if (!latestMessage) {
    return;
  }

  const thread = latestMessage.channel as ThreadChannel;
  const stopTyping = startTyping(thread);
  const startedAt = Date.now();
  let refreshStatus: ReturnType<typeof setInterval> | undefined;

  try {
    const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    const settings = getThreadSettings(thread.id);
    if (state.running) {
      state.running.workspace = workspace;
    }
    await persistRunningJob(state, "preparing", "Workspace is ready.");
    const sessionState = await loadOrRecoverSession(workspace);
    const sessionId = sessionState?.sessionId;
    await persistRunningJob(state, "attachments", "Saving Discord attachments.");
    const attachmentResults: AttachmentSaveResult[] = [];
    let usedAttachmentBytes = 0;
    if (settings.includeAttachments) {
      for (const message of job.messages) {
        const result = await saveDiscordAttachments(message.attachments.values(), workspace, message.id, {
          timeoutMs: config.attachmentDownloadTimeoutMs,
          maxFileBytes: config.attachmentMaxFileBytes,
          maxTotalBytes: config.attachmentMaxTotalBytes,
          usedBytes: usedAttachmentBytes
        });
        usedAttachmentBytes = result.usedBytes;
        attachmentResults.push(result);
      }
    }
    const savedAttachments = attachmentResults.flatMap((result) => result.saved);
    const failedAttachments = attachmentResults.flatMap((result) => result.failed);
    const imagePaths = savedAttachments.filter((attachment) => attachment.isImage).map((attachment) => attachment.path);
    const attachmentPrompt = formatAttachmentPrompt(savedAttachments, failedAttachments, config.language);
    const prompt = [
      job.prompt || messages.analyzeAttachments,
      attachmentPrompt,
      messages.replyInstruction
    ].join("\n");

    const statusMessage = await sendThreadMessage(thread, {
      embeds: [formatRunStartEmbed({
        jobId: job.id,
        workspaceDir: displayWorkspacePath(thread.id, workspace.dir),
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        sessionId,
        queued: state.queue.length,
        warning: buildOperationalWarning()
      }, config.language)],
      components: runningComponents(),
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "job.start", threadId: thread.id, jobId: job.id, phase: "preparing" });
    if (state.running) {
      state.running.statusMessage = statusMessage;
    }

    refreshStatus = setInterval(() => {
      const running = state.running;
      if (!running?.statusMessage) {
        return;
      }
      void editDiscordMessage(running.statusMessage, {
        embeds: [buildStatusEmbed(state, true)],
        components: runningComponents(),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), {
        action: "job.status.edit",
        threadId: thread.id,
        jobId: running.id,
        phase: running.phase
      }).catch(() => undefined);
    }, 30_000);

    let streamedMessages = 0;
    await persistRunningJob(state, "codex", "Codex process started.");
    const result = await runCodex({
      codexBin: config.codexBin,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      prompt,
      workspaceDir: workspace.dir,
      sessionId,
      sessionLogPath: sessionState?.sessionLogPath,
      imagePaths,
      signal: state.running?.abortController.signal,
      runTimeoutMs: config.codexRunTimeoutMs,
      idleTimeoutMs: config.codexIdleTimeoutMs,
      messageHandlerTimeoutMs: config.discordSendTimeoutMs,
      onActivity: () => {
        if (state.running) {
          state.running.lastActivityAt = Date.now();
          state.running.idleDeadlineAt = config.codexIdleTimeoutMs ? Date.now() + config.codexIdleTimeoutMs : undefined;
        }
      },
      onEvent: (event) => {
        void persistRunningJob(state, event.phase, event.summary);
      },
      onMessage: async (content) => {
        streamedMessages += 1;
        await persistRunningJob(state, "sending", "Sending Codex response to Discord.");
        await sendFormatted(thread, formatCodexResponse(content, config.language), workspace.stateDir);
      }
    });

    if (result.sessionId) {
      await saveSessionId(workspace, result.sessionId, result.sessionLogPath ?? sessionState?.sessionLogPath);
    }
    if (streamedMessages === 0) {
      await persistRunningJob(state, "sending", "Sending final Codex response to Discord.");
      await sendFormatted(thread, formatCodexResponse(result.content, config.language), workspace.stateDir);
    }

    await persistRunningJob(state, "completed", "Codex job completed.", "completed");

    if (state.running?.statusMessage) {
      const stats = await getWorkspaceStats(workspace);
      await editDiscordMessage(state.running.statusMessage, {
        embeds: [formatRunCompleteEmbed({
          elapsedMs: Date.now() - startedAt,
          sessionId: result.sessionId ?? sessionId,
          files: stats.files,
          bytes: stats.bytes
        }, config.language)],
        components: idleComponents(),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "job.complete.edit", threadId: thread.id, jobId: job.id, phase: "completed" });
    }
  } catch (error) {
    const running = state.running;
    if (running?.stopRequested) {
      console.log(`Codex run stopped by user request for thread ${thread.id}`);
      await persistRunningJob(state, "stopped", "Codex job stopped.", "stopped");
      if (running.statusMessage) {
        await editDiscordMessage(running.statusMessage, {
          embeds: [formatRunStoppedEmbed({
            elapsedMs: Date.now() - startedAt
          }, config.language)],
          components: idleComponents(),
          allowedMentions: { parse: [] }
        }, discordApiOptions(), { action: "job.stopped.edit", threadId: thread.id, jobId: running.id, phase: "stopped" })
          .catch(() => undefined);
      }
      return;
    }

    console.error(`Codex failed for thread ${thread.id}`, error);
    retryableJobs.set(thread.id, job);
    await persistRunningJob(state, "failed", error instanceof Error ? error.message : String(error), "failed");
    if (running?.statusMessage) {
      await editDiscordMessage(running.statusMessage, {
        embeds: [formatRunFailedEmbed({
          elapsedMs: Date.now() - startedAt,
          lastEvent: running.lastEvent
        }, config.language)],
        components: failedComponents(),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "job.failed.edit", threadId: thread.id, jobId: running.id, phase: "failed" })
        .catch(() => undefined);
    }
    await sendFormatted(thread, formatError(error, config.language));
  } finally {
    if (refreshStatus) {
      clearInterval(refreshStatus);
    }
    stopTyping();
  }
}

async function handleThreadCommand(thread: ThreadChannel, command: ThreadCommand): Promise<void> {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const state = threadStates.get(thread.id);

  switch (command.name) {
    case "help":
      await sendThreadMessage(thread, { content: formatCommandHelp(config.language), allowedMentions: { parse: [] } }, discordApiOptions(), {
        action: "command.help",
        threadId: thread.id
      });
      return;
    case "panel":
      await sendControlPanel(thread, state);
      return;
    case "settings":
      await sendThreadSettings(thread);
      return;
    case "queue":
      await sendThreadQueue(thread, state);
      return;
    case "status": {
      await sendThreadStatus(thread, state);
      return;
    }
    case "workspace": {
      const stats = await getWorkspaceStats(workspace);
      const sessionId = await loadOrRecoverSessionId(workspace);
      await sendThreadMessage(thread, {
        embeds: [formatWorkspaceEmbed({
          path: displayWorkspacePath(thread.id, workspace.dir),
          sessionId,
          files: stats.files,
          bytes: stats.bytes,
          updatedAt: stats.updatedAt,
          warning: buildOperationalWarning()
        }, config.language)],
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "command.workspace", threadId: thread.id });
      return;
    }
    case "reset":
      await resetSession(workspace);
      await sendThreadMessage(thread, {
        content: messages.reset,
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "command.reset", threadId: thread.id });
      return;
    case "stop":
      if (state?.running) {
        state.running.stopRequested = true;
        state.running.abortController.abort();
      }
      if (state) {
        state.queue.length = 0;
      }
      await sendThreadMessage(thread, {
        content: messages.stopped,
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "command.stop", threadId: thread.id });
      return;
    case "stop-current":
      if (state?.running) {
        state.running.stopRequested = true;
        state.running.abortController.abort();
      }
      await sendThreadMessage(thread, {
        content: messages.stopCurrentRequested,
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "command.stop-current", threadId: thread.id });
      return;
    case "logs":
      await sendThreadMessage(thread, {
        content: [
          messages.logsTitle,
          messages.logsIntro,
          "```bash",
          "codex-discord-agent logs",
          "sudo journalctl -u codex-discord-agent -f",
          "```"
        ].join("\n"),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "command.logs", threadId: thread.id });
      return;
    case "clean": {
      const result = await cleanStaleWorkspaces(
        config.baseWorkspaceDir,
        config.discordGuildId,
        config.staleWorkspaceDays,
        thread.id
      );
      await sendThreadMessage(thread, {
        content: messages.cleanDone(result.removed, result.skipped),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "command.clean", threadId: thread.id });
      return;
    }
  }
}

async function notifyInterruptedIfAny(thread: ThreadChannel): Promise<void> {
  const state = threadStates.get(thread.id);
  if (state?.running) {
    return;
  }
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const interrupted = await markJobInterrupted(workspace);
  if (interrupted?.status !== "interrupted") {
    return;
  }
  await sendThreadMessage(thread, {
    embeds: [formatStatusEmbed({
      running: false,
      jobId: interrupted.jobId,
      phase: interrupted.phase,
      lastEvent: messages.interruptedHint,
      queued: 0,
      warning: buildOperationalWarning()
    }, config.language)],
    components: idleComponents(),
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "job.interrupted.notice", threadId: thread.id, jobId: interrupted.jobId });
}

async function handleButtonInteraction(interaction: ButtonInteraction, thread: ThreadChannel): Promise<void> {
  const state = threadStates.get(thread.id);
  switch (interaction.customId) {
    case "codex:refresh":
      await sendThreadStatus(thread, state);
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.refresh",
        threadId: thread.id
      });
      return;
    case "codex:settings":
      await sendThreadSettings(thread);
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.settings",
        threadId: thread.id
      });
      return;
    case "codex:queue":
      await sendThreadQueue(thread, state);
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.queue",
        threadId: thread.id
      });
      return;
    case "codex:queue:cancel":
      cancelSelectedQueuedJob(state);
      await replyToInteraction(interaction, { content: messages.queueUpdated, ephemeral: true }, discordApiOptions(), {
        action: "button.queue.cancel",
        threadId: thread.id
      });
      await sendThreadQueue(thread, state);
      return;
    case "codex:queue:run-next":
      moveSelectedQueuedJobNext(state);
      await replyToInteraction(interaction, { content: messages.queueUpdated, ephemeral: true }, discordApiOptions(), {
        action: "button.queue.run-next",
        threadId: thread.id
      });
      await sendThreadQueue(thread, state);
      return;
    case "codex:queue:clear":
      if (state) {
        state.queue.length = 0;
        state.selectedQueueJobId = undefined;
      }
      await replyToInteraction(interaction, { content: messages.queueUpdated, ephemeral: true }, discordApiOptions(), {
        action: "button.queue.clear",
        threadId: thread.id
      });
      await sendThreadQueue(thread, state);
      return;
    case "codex:stop-current":
      if (state?.running) {
        state.running.stopRequested = true;
        state.running.abortController.abort();
      }
      await replyToInteraction(interaction, { content: messages.stopCurrentRequested, ephemeral: true }, discordApiOptions(), {
        action: "button.stop-current",
        threadId: thread.id,
        jobId: state?.running?.id
      });
      return;
    case "codex:stop-all":
      if (state?.running) {
        state.running.stopRequested = true;
        state.running.abortController.abort();
      }
      if (state) {
        state.queue.length = 0;
      }
      await replyToInteraction(interaction, { content: messages.stopped, ephemeral: true }, discordApiOptions(), {
        action: "button.stop-all",
        threadId: thread.id,
        jobId: state?.running?.id
      });
      return;
    case "codex:workspace":
      await handleThreadCommand(thread, { name: "workspace", args: [] });
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.workspace",
        threadId: thread.id
      });
      return;
    case "codex:logs":
      await handleThreadCommand(thread, { name: "logs", args: [] });
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.logs",
        threadId: thread.id
      });
      return;
    case "codex:retry":
    case "codex:reset-retry":
      await retryLastJob(thread, interaction.customId === "codex:reset-retry");
      await replyToInteraction(interaction, {
        content: interaction.customId === "codex:reset-retry" ? messages.resetRetryQueued : messages.retryQueued,
        ephemeral: true
      }, discordApiOptions(), {
        action: interaction.customId,
        threadId: thread.id
      });
      return;
  }
}

async function handleSelectMenuInteraction(interaction: StringSelectMenuInteraction, thread: ThreadChannel): Promise<void> {
  if (interaction.customId === "codex:queue:select") {
    const state = getThreadState(thread.id);
    state.selectedQueueJobId = interaction.values[0];
    await interaction.update({
      embeds: [formatQueueEmbed({
        jobs: state.queue,
        selectedJobId: state.selectedQueueJobId
      }, config.language)],
      components: queueComponents(state),
      allowedMentions: { parse: [] }
    });
    return;
  }

  const settings = getThreadSettings(thread.id);
  const value = interaction.values[0];
  if (!value) {
    return;
  }

  switch (interaction.customId) {
    case "codex:settings:model":
      settings.model = value;
      break;
    case "codex:settings:reasoning":
      settings.reasoningEffort = value;
      break;
    case "codex:settings:paths":
      settings.hideWorkspacePaths = value === "hide";
      break;
    case "codex:settings:attachments":
      settings.includeAttachments = value === "include";
      break;
    default:
      return;
  }

  await interaction.update({
    embeds: [formatSettingsEmbed(settings, config.language)],
    components: settingsComponents(settings),
    allowedMentions: { parse: [] }
  });
}

async function retryLastJob(thread: ThreadChannel, resetFirst: boolean): Promise<void> {
  const job = retryableJobs.get(thread.id);
  if (!job) {
    await sendThreadMessage(thread, {
      content: config.language === "ko" ? "재시도할 최근 작업이 없습니다." : "There is no recent job to retry.",
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "retry.missing", threadId: thread.id });
    return;
  }
  if (resetFirst) {
    const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    await resetSession(workspace);
  }
  enqueueThreadJob(thread.id, {
    ...job,
    id: createJobId(),
    createdAt: Date.now()
  });
}

function runningComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("codex:refresh").setLabel(messages.actions.refresh).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:stop-current").setLabel(messages.actions.stopCurrent).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("codex:stop-all").setLabel(messages.actions.stopAll).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("codex:workspace").setLabel(messages.actions.workspace).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:logs").setLabel(messages.actions.logs).setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("codex:settings").setLabel(messages.actions.settings).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:queue").setLabel(messages.actions.queue).setStyle(ButtonStyle.Secondary)
    )
  ];
}

function failedComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("codex:retry").setLabel(messages.actions.retry).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("codex:reset-retry").setLabel(messages.actions.resetRetry).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:settings").setLabel(messages.actions.settings).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:queue").setLabel(messages.actions.queue).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:logs").setLabel(messages.actions.logs).setStyle(ButtonStyle.Secondary)
    )
  ];
}

function idleComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("codex:refresh").setLabel(messages.actions.refresh).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:settings").setLabel(messages.actions.settings).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:queue").setLabel(messages.actions.queue).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:workspace").setLabel(messages.actions.workspace).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("codex:logs").setLabel(messages.actions.logs).setStyle(ButtonStyle.Secondary)
    )
  ];
}

function queueComponents(state: ThreadState | undefined): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const queue = state?.queue ?? [];
  const selectedJobId = state?.selectedQueueJobId;
  const hasSelectedJob = Boolean(selectedJobId && queue.some((job) => job.id === selectedJobId));
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (queue.length > 0) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("codex:queue:select")
        .setPlaceholder(messages.labels.queue)
        .addOptions(queue.slice(0, 25).map((job, index) => ({
          label: `${index + 1}. ${job.promptSummary}`.slice(0, 100),
          description: job.authorName.slice(0, 100),
          value: job.id,
          default: job.id === selectedJobId
        })))
    ));
  }

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("codex:queue:run-next")
      .setLabel(messages.actions.runNext)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasSelectedJob),
    new ButtonBuilder()
      .setCustomId("codex:queue:cancel")
      .setLabel(messages.actions.cancelSelected)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasSelectedJob),
    new ButtonBuilder()
      .setCustomId("codex:queue:clear")
      .setLabel(messages.actions.clearQueue)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(queue.length === 0)
  ));

  return rows;
}

function settingsComponents(settings: ThreadSettings): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("codex:settings:model")
        .setPlaceholder(messages.labels.model)
        .addOptions(config.codexModelChoices.slice(0, 25).map((model) => ({
          label: model.slice(0, 100),
          value: model,
          default: model === settings.model
        })))
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("codex:settings:reasoning")
        .setPlaceholder(messages.labels.reasoning)
        .addOptions(["minimal", "low", "medium", "high"].map((effort) => ({
          label: effort,
          value: effort,
          default: effort === settings.reasoningEffort
        })))
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("codex:settings:paths")
        .setPlaceholder(messages.labels.hidePaths)
        .addOptions([
          { label: messages.values.disabled, value: "show", default: !settings.hideWorkspacePaths },
          { label: messages.values.enabled, value: "hide", default: settings.hideWorkspacePaths }
        ])
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("codex:settings:attachments")
        .setPlaceholder(messages.labels.attachments)
        .addOptions([
          { label: messages.values.enabled, value: "include", default: settings.includeAttachments },
          { label: messages.values.disabled, value: "ignore", default: !settings.includeAttachments }
        ])
    )
  ];
}

function buildStatusEmbed(state: ThreadState, runningFlag: boolean) {
  const running = state.running;
  return formatStatusEmbed({
    running: runningFlag,
    jobId: running?.id,
    phase: running?.phase,
    lastEvent: running?.lastEvent,
    timeoutAt: running?.idleDeadlineAt ?? running?.timeoutAt,
    elapsedMs: running ? Date.now() - running.startedAt : undefined,
    idleMs: running ? Date.now() - running.lastActivityAt : undefined,
    queued: state.queue.length,
    queueSummary: formatQueueSummary(state.queue),
    warning: buildOperationalWarning()
  }, config.language);
}

async function buildIdleStatusEmbed(thread: ThreadChannel, state: ThreadState | undefined) {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const lastJob = await markJobInterrupted(workspace);
  return formatStatusEmbed({
    running: false,
    jobId: lastJob?.jobId,
    phase: lastJob?.status,
    lastEvent: lastJob?.status === "interrupted" ? messages.interruptedHint : lastJob?.error,
    queued: state?.queue.length ?? 0,
    queueSummary: formatQueueSummary(state?.queue ?? []),
    warning: buildOperationalWarning()
  }, config.language);
}

function formatQueueSummary(queue: QueuedJob[]): string | undefined {
  if (queue.length === 0) {
    return undefined;
  }
  return queue.slice(0, 5)
    .map((job, index) => `**${index + 1}.** ${escapeMarkdown(job.authorName)}: ${escapeMarkdown(job.promptSummary)}`)
    .join("\n");
}

async function persistRunningJob(
  state: ThreadState,
  phase: string,
  lastEvent: string,
  status: "running" | "completed" | "failed" | "stopped" | "interrupted" = "running"
): Promise<void> {
  const running = state.running;
  if (!running) {
    return;
  }

  running.phase = phase;
  running.lastEvent = lastEvent;
  running.lastActivityAt = Date.now();
  running.idleDeadlineAt = config.codexIdleTimeoutMs ? Date.now() + config.codexIdleTimeoutMs : undefined;

  if (!running.workspace) {
    return;
  }

  await saveJobState(running.workspace, {
    jobId: running.id,
    status,
    phase,
    promptSummary: running.job.promptSummary,
    startedAt: new Date(running.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: status === "running" ? undefined : new Date().toISOString(),
    error: status === "failed" ? lastEvent : undefined,
    queued: state.queue.length
  });
}

function discordApiOptions() {
  return {
    timeoutMs: config.discordSendTimeoutMs,
    retries: 2
  };
}

function buildOperationalWarning(): string | undefined {
  return isAllowlistOpen() ? messages.allowlistWarning : undefined;
}

function isAllowlistOpen(): boolean {
  return config.allowedUserIds.length === 0 && config.allowedRoleIds.length === 0;
}

function displayWorkspacePath(threadId: string, workspaceDir: string): string {
  return getThreadSettings(threadId).hideWorkspacePaths ? "[hidden]" : workspaceDir;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([*_`~|])/g, "\\$1");
}

async function sendThreadStatus(thread: ThreadChannel, state: ThreadState | undefined): Promise<void> {
  const embed = state?.running
    ? buildStatusEmbed(state, true)
    : await buildIdleStatusEmbed(thread, state);
  await sendThreadMessage(thread, {
    embeds: [embed],
    components: state?.running ? runningComponents() : idleComponents(),
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "status.send", threadId: thread.id, jobId: state?.running?.id, phase: state?.running?.phase });
}

async function sendControlPanel(thread: ThreadChannel, state: ThreadState | undefined): Promise<void> {
  const embed = state?.running
    ? formatControlPanelEmbed({
      running: true,
      jobId: state.running.id,
      phase: state.running.phase,
      lastEvent: state.running.lastEvent,
      queued: state.queue.length,
      queueSummary: formatQueueSummary(state.queue),
      warning: buildOperationalWarning()
    }, config.language)
    : formatControlPanelEmbed({
      running: false,
      queued: state?.queue.length ?? 0,
      queueSummary: formatQueueSummary(state?.queue ?? []),
      warning: buildOperationalWarning()
    }, config.language);

  await sendThreadMessage(thread, {
    embeds: [embed],
    components: state?.running ? runningComponents() : idleComponents(),
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "panel.send", threadId: thread.id, jobId: state?.running?.id, phase: state?.running?.phase });
}

async function sendThreadSettings(thread: ThreadChannel): Promise<void> {
  const settings = getThreadSettings(thread.id);
  await sendThreadMessage(thread, {
    embeds: [formatSettingsEmbed(settings, config.language)],
    components: settingsComponents(settings),
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "settings.send", threadId: thread.id });
}

async function sendThreadQueue(thread: ThreadChannel, state: ThreadState | undefined): Promise<void> {
  await sendThreadMessage(thread, {
    embeds: [formatQueueEmbed({
      jobs: state?.queue ?? [],
      selectedJobId: state?.selectedQueueJobId
    }, config.language)],
    components: queueComponents(state),
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "queue.send", threadId: thread.id });
}

function cancelSelectedQueuedJob(state: ThreadState | undefined): void {
  if (!state?.selectedQueueJobId) {
    return;
  }
  const index = state.queue.findIndex((job) => job.id === state.selectedQueueJobId);
  if (index >= 0) {
    state.queue.splice(index, 1);
  }
  state.selectedQueueJobId = undefined;
}

function moveSelectedQueuedJobNext(state: ThreadState | undefined): void {
  if (!state?.selectedQueueJobId) {
    return;
  }
  const index = state.queue.findIndex((job) => job.id === state.selectedQueueJobId);
  if (index <= 0) {
    return;
  }
  const [job] = state.queue.splice(index, 1);
  if (job) {
    state.queue.unshift(job);
  }
}

async function loadOrRecoverSessionId(workspace: Awaited<ReturnType<typeof ensureThreadWorkspace>>): Promise<string | undefined> {
  return (await loadOrRecoverSession(workspace))?.sessionId;
}

async function loadOrRecoverSession(workspace: Awaited<ReturnType<typeof ensureThreadWorkspace>>): Promise<Awaited<ReturnType<typeof loadSessionState>>> {
  const savedSession = await loadSessionState(workspace);
  if (savedSession?.sessionId) {
    return savedSession;
  }

  const recoveredSessionId = await findLatestCodexSessionIdForWorkspace(workspace.dir);
  if (!recoveredSessionId) {
    return undefined;
  }

  await saveSessionId(workspace, recoveredSessionId);
  console.log(`Recovered Codex session ${recoveredSessionId} for workspace ${workspace.dir}`);
  return { sessionId: recoveredSessionId, updatedAt: new Date().toISOString() };
}

function startTyping(thread: ThreadChannel): () => void {
  void sendThreadTyping(thread, discordApiOptions(), { action: "typing", threadId: thread.id });

  const timer = setInterval(() => {
    void sendThreadTyping(thread, discordApiOptions(), { action: "typing", threadId: thread.id });
  }, 8_000);

  return () => clearInterval(timer);
}

async function sendFormatted(
  thread: ThreadChannel,
  content: string,
  fileDir?: string
): Promise<void> {
  if (fileDir && shouldSendAsFile(content, config.language)) {
    await mkdir(fileDir, { recursive: true });
    const filePath = path.join(fileDir, `response-${Date.now()}.md`);
    await writeFile(filePath, `${content.trim()}\n`, "utf8");
    await sendThreadMessage(thread, {
      content: summarizeLongResponse(content, config.language),
      files: [new AttachmentBuilder(filePath, { name: "codex-response.md" })],
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "response.file", threadId: thread.id });
    return;
  }

  for (const chunk of prefixChunks(splitDiscordMessage(content, undefined, config.language))) {
    await sendThreadMessage(thread, {
      content: chunk,
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "response.chunk", threadId: thread.id });
  }
}
