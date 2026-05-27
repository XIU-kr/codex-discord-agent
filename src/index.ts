import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type ThreadChannel
} from "discord.js";
import { saveDiscordAttachments, formatAttachmentPrompt } from "./attachments";
import { runCodex } from "./codex";
import { loadConfig } from "./config";
import {
  formatBytes,
  formatCodexResponse,
  formatDuration,
  formatError,
  formatRunComplete,
  formatRunHeader,
  prefixChunks,
  shouldSendAsFile,
  splitDiscordMessage
} from "./discordFormat";
import { t } from "./i18n";
import { formatCommandHelp, parseThreadCommand, type ThreadCommand } from "./threadCommands";
import {
  cleanStaleWorkspaces,
  ensureThreadWorkspace,
  getWorkspaceStats,
  loadSessionId,
  resetSession,
  saveSessionId
} from "./workspaces";

interface QueuedJob {
  message: Message;
  prompt: string;
}

interface RunningJob {
  startedAt: number;
  abortController: AbortController;
  statusMessage?: Message;
}

interface ThreadState {
  queue: QueuedJob[];
  running?: RunningJob;
}

const config = loadConfig();
const messages = t(config.language);
const threadStates = new Map<string, ThreadState>();

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
});

client.on(Events.ThreadCreate, async (thread) => {
  if (!isManagedThread(thread)) {
    return;
  }

  try {
    await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    await thread.send({
      content: messages.workspaceConnected.join("\n"),
      allowedMentions: { parse: [] }
    });
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
    await thread.send({
      content: messages.denied,
      allowedMentions: { parse: [] }
    });
    return;
  }

  const command = parseThreadCommand(prompt);
  if (command) {
    await handleThreadCommand(thread, command);
    return;
  }

  if (!prompt && message.attachments.size === 0) {
    return;
  }

  enqueueThreadJob(thread.id, {
    message,
    prompt
  });
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
  if (config.allowedUserIds.length === 0 && config.allowedRoleIds.length === 0) {
    return true;
  }

  if (config.allowedUserIds.includes(message.author.id)) {
    return true;
  }

  const member = message.member ?? (await message.guild?.members.fetch(message.author.id).catch(() => null));
  if (!member) {
    return false;
  }

  return config.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId));
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

function enqueueThreadJob(threadId: string, job: QueuedJob): void {
  const state = getThreadState(threadId);
  state.queue.push(job);

  if (!state.running) {
    void processNextJob(threadId);
  }
}

async function processNextJob(threadId: string): Promise<void> {
  const state = getThreadState(threadId);
  if (state.running) {
    return;
  }

  const job = state.queue.shift();
  if (!job) {
    if (state.queue.length === 0) {
      threadStates.delete(threadId);
    }
    return;
  }

  const abortController = new AbortController();
  state.running = {
    startedAt: Date.now(),
    abortController
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
  const thread = job.message.channel as ThreadChannel;
  const stopTyping = startTyping(thread);
  const startedAt = Date.now();

  try {
    const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    const sessionId = await loadSessionId(workspace);
    const savedAttachments = await saveDiscordAttachments(
      job.message.attachments.values(),
      workspace,
      job.message.id
    );
    const imagePaths = savedAttachments.filter((attachment) => attachment.isImage).map((attachment) => attachment.path);
    const attachmentPrompt = formatAttachmentPrompt(savedAttachments, config.language);
    const prompt = [
      job.prompt || messages.analyzeAttachments,
      attachmentPrompt,
      messages.replyInstruction
    ].join("\n");

    const statusMessage = await thread.send({
      content: formatRunHeader({
        workspaceDir: workspace.dir,
        model: config.codexModel,
        reasoningEffort: config.codexReasoningEffort,
        sessionId,
        queued: state.queue.length
      }, config.language),
      allowedMentions: { parse: [] }
    });
    if (state.running) {
      state.running.statusMessage = statusMessage;
    }

    const result = await runCodex({
      codexBin: config.codexBin,
      model: config.codexModel,
      reasoningEffort: config.codexReasoningEffort,
      prompt,
      workspaceDir: workspace.dir,
      sessionId,
      imagePaths,
      signal: state.running?.abortController.signal
    });

    if (result.sessionId) {
      await saveSessionId(workspace, result.sessionId);
    }

    const stats = await getWorkspaceStats(workspace);
    await statusMessage.edit({
      content: formatRunComplete({
        elapsedMs: Date.now() - startedAt,
        sessionId: result.sessionId ?? sessionId,
        files: stats.files,
        bytes: stats.bytes
      }, config.language),
      allowedMentions: { parse: [] }
    });

    await sendFormatted(thread, formatCodexResponse(result.content, config.language), workspace.stateDir);
  } catch (error) {
    console.error(`Codex failed for thread ${thread.id}`, error);
    const running = state.running;
    if (running?.statusMessage) {
      await running.statusMessage.edit({
        content: `${messages.runFailed}\n${messages.labels.elapsed}: \`${formatDuration(Date.now() - startedAt, config.language)}\``,
        allowedMentions: { parse: [] }
      }).catch(() => undefined);
    }
    await sendFormatted(thread, formatError(error, config.language));
  } finally {
    stopTyping();
  }
}

async function handleThreadCommand(thread: ThreadChannel, command: ThreadCommand): Promise<void> {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const state = threadStates.get(thread.id);

  switch (command.name) {
    case "help":
      await thread.send({ content: formatCommandHelp(config.language), allowedMentions: { parse: [] } });
      return;
    case "status": {
      const running = state?.running;
      const content = running
        ? [
          messages.statusTitle,
          `${messages.labels.running}: \`${messages.values.yes}\``,
          `${messages.labels.elapsed}: \`${formatDuration(Date.now() - running.startedAt, config.language)}\``,
          `${messages.labels.queued}: \`${state.queue.length}\``
        ].join("\n")
        : [
          messages.statusTitle,
          `${messages.labels.running}: \`${messages.values.no}\``,
          `${messages.labels.queued}: \`${state?.queue.length ?? 0}\``
        ].join("\n");
      await thread.send({ content, allowedMentions: { parse: [] } });
      return;
    }
    case "workspace": {
      const stats = await getWorkspaceStats(workspace);
      const sessionId = await loadSessionId(workspace);
      const content = [
        messages.workspaceTitle,
        `${messages.labels.path}: \`${workspace.dir}\``,
        `${messages.labels.session}: \`${sessionId ?? messages.values.none}\``,
        `${messages.labels.size}: \`${messages.values.files(stats.files)} / ${formatBytes(stats.bytes)}\``,
        `${messages.labels.updated}: \`${stats.updatedAt?.toISOString() ?? messages.values.unknown}\``
      ].join("\n");
      await thread.send({ content, allowedMentions: { parse: [] } });
      return;
    }
    case "reset":
      await resetSession(workspace);
      await thread.send({
        content: messages.reset,
        allowedMentions: { parse: [] }
      });
      return;
    case "stop":
      if (state?.running) {
        state.running.abortController.abort();
      }
      if (state) {
        state.queue.length = 0;
      }
      await thread.send({
        content: messages.stopped,
        allowedMentions: { parse: [] }
      });
      return;
    case "logs":
      await thread.send({
        content: [
          messages.logsTitle,
          messages.logsIntro,
          "```bash",
          "codex-discord-agent logs",
          "sudo journalctl -u codex-discord-agent -f",
          "```"
        ].join("\n"),
        allowedMentions: { parse: [] }
      });
      return;
    case "clean": {
      const result = await cleanStaleWorkspaces(
        config.baseWorkspaceDir,
        config.discordGuildId,
        config.staleWorkspaceDays,
        thread.id
      );
      await thread.send({
        content: messages.cleanDone(result.removed, result.skipped),
        allowedMentions: { parse: [] }
      });
      return;
    }
  }
}

function startTyping(thread: ThreadChannel): () => void {
  void thread.sendTyping().catch(() => undefined);

  const timer = setInterval(() => {
    void thread.sendTyping().catch(() => undefined);
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
    await thread.send({
      content: messages.longResponseFile,
      files: [new AttachmentBuilder(filePath, { name: "codex-response.md" })],
      allowedMentions: { parse: [] }
    });
    return;
  }

  for (const chunk of prefixChunks(splitDiscordMessage(content, undefined, config.language))) {
    await thread.send({
      content: chunk,
      allowedMentions: { parse: [] }
    });
  }
}
