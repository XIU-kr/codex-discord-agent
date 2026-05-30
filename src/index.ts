import { Buffer } from "node:buffer";
import path from "node:path";
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  GatewayIntentBits,
  type ApplicationCommandDataResolvable,
  type Message,
  MessageFlags,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type ThreadChannel
} from "discord.js";
import { saveDiscordAttachments, formatAttachmentPrompt, type AttachmentSaveResult } from "./attachments";
import { runCodex, type CodexUsage } from "./codex";
import { findLatestCodexSessionIdForWorkspace } from "./codexSessions";
import {
  buildCodexSlashPrompt,
  codexDiscordCommandAliases,
  codexDiscordCommandFromAlias
} from "./codexDiscordCommands";
import { loadConfig } from "./config";
import { runDoctor } from "./doctor";
import {
  editDiscordMessage,
  replyToInteraction,
  sendThreadMessage,
  sendThreadTyping
} from "./discordApi";
import {
  formatCodexResponse,
  formatControlPanelEmbed,
  formatDoctorEmbed,
  formatQueueEmbed,
  formatRunCompleteEmbed,
  formatRunFailedEmbed,
  formatRunStartEmbed,
  formatRunStoppedEmbed,
  formatSettingsEmbed,
  formatStatusEmbed,
  formatUsageEmbed,
  formatWorkspaceEmbed,
  prefixChunks,
  shouldSendAsFile,
  splitDiscordMessage,
  summarizeLongResponse,
} from "./discordFormat";
import { t } from "./i18n";
import { buildCodexPrompt, stripHiddenPromptContent } from "./prompts";
import { runShellCommand, type ShellCommandResult, type ShellCommandSnapshot } from "./shellCommands";
import { isStatusQuestion } from "./statusQuestions";
import { commandNameFromAlias, formatCommandHelp, parseThreadCommand, type ThreadCommand, type ThreadCommandName } from "./threadCommands";
import {
  cleanStaleWorkspaces,
  clearGlobalProfileState,
  ensureGuildWorkspace,
  ensureThreadWorkspace,
  getWorkspaceStats,
  listStoredThreadJobStates,
  loadGlobalProfileState,
  loadJobState,
  loadPanelState,
  loadSessionState,
  loadUsageState,
  markJobInterrupted,
  resetSession,
  saveGlobalProfileState,
  saveJobState,
  savePanelState,
  saveSessionId,
  saveUsageState,
  type GlobalProfileState,
  type StoredJobState,
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
  threadId: string;
  recoveredFromJobId?: string;
  initialProgressEvents?: string[];
  persistedPrompt?: string;
  recoveryAttempts?: number;
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
  interruptRequested?: boolean;
  workspace?: ThreadWorkspace;
  usage?: CodexUsage;
  progressEvents: string[];
  codexResponse?: string;
  codexTranscript?: string;
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
const slashCommandDescriptions: Record<ThreadCommandName, { en: string; ko: string }> = {
  help: {
    en: "Show command help.",
    ko: "명령어 도움말을 봅니다."
  },
  panel: {
    en: "Show or create the pinned control panel.",
    ko: "고정 컨트롤 패널을 보거나 만듭니다."
  },
  settings: {
    en: "Change this thread's model and display settings.",
    ko: "이 스레드의 모델과 표시 설정을 바꿉니다."
  },
  queue: {
    en: "Manage queued jobs.",
    ko: "대기 중인 작업을 관리합니다."
  },
  doctor: {
    en: "Check Codex, auth, workspace, and access configuration.",
    ko: "Codex, 인증, 작업 공간, 접근 설정을 점검합니다."
  },
  usage: {
    en: "Show this thread's latest Codex token usage.",
    ko: "이 스레드의 최근 Codex 토큰 사용량을 봅니다."
  },
  status: {
    en: "Show this thread's job status.",
    ko: "현재 스레드의 작업 상태를 봅니다."
  },
  workspace: {
    en: "Show workspace path, session, and size.",
    ko: "작업 공간 경로, 세션, 크기를 봅니다."
  },
  reset: {
    en: "Start a fresh Codex session for this thread.",
    ko: "현재 스레드의 Codex 세션을 새로 시작합니다."
  },
  stop: {
    en: "Stop the running job and clear the queue.",
    ko: "실행 중인 작업을 중단하고 대기열을 비웁니다."
  },
  "stop-current": {
    en: "Stop only the running job and keep the queue.",
    ko: "실행 중인 작업만 중단하고 대기열은 유지합니다."
  },
  logs: {
    en: "Show server log commands.",
    ko: "서버 로그 확인 명령을 보여줍니다."
  },
  clean: {
    en: "Remove stale workspaces.",
    ko: "오래된 작업 공간을 정리합니다."
  },
  shell: {
    en: "Run a server shell command.",
    ko: "서버 셸 명령을 실행합니다."
  }
};
const slashCommandAliases: Array<{ name: string; description: { en: string; ko: string } }> = [
  { name: "help", description: slashCommandDescriptions.help },
  { name: "도움말", description: slashCommandDescriptions.help },
  { name: "status", description: slashCommandDescriptions.status },
  { name: "상태", description: slashCommandDescriptions.status },
  { name: "settings", description: slashCommandDescriptions.settings },
  { name: "설정", description: slashCommandDescriptions.settings },
  { name: "usage", description: slashCommandDescriptions.usage },
  { name: "사용량", description: slashCommandDescriptions.usage },
  { name: "logs", description: slashCommandDescriptions.logs },
  { name: "로그", description: slashCommandDescriptions.logs },
  { name: "queue", description: slashCommandDescriptions.queue },
  { name: "대기열", description: slashCommandDescriptions.queue },
  { name: "stop", description: slashCommandDescriptions.stop },
  { name: "중단", description: slashCommandDescriptions.stop },
  { name: "reset", description: slashCommandDescriptions.reset },
  { name: "초기화", description: slashCommandDescriptions.reset },
  { name: "doctor", description: slashCommandDescriptions.doctor },
  { name: "진단", description: slashCommandDescriptions.doctor },
  { name: "workspace", description: slashCommandDescriptions.workspace },
  { name: "작업공간", description: slashCommandDescriptions.workspace },
  { name: "clean", description: slashCommandDescriptions.clean },
  { name: "정리", description: slashCommandDescriptions.clean },
  { name: "shell", description: slashCommandDescriptions.shell },
  { name: "터미널", description: slashCommandDescriptions.shell }
];
const genericCodexCommandAliases: Array<{ name: string; description: { en: string; ko: string } }> = [
  {
    name: "codex",
    description: {
      en: "Send any Codex slash command.",
      ko: "임의의 Codex slash 명령을 실행합니다."
    }
  },
  {
    name: "코덱스",
    description: {
      en: "Send any Codex slash command.",
      ko: "임의의 Codex slash 명령을 실행합니다."
    }
  },
  {
    name: "codexcmd",
    description: {
      en: "Send any Codex slash command.",
      ko: "임의의 Codex slash 명령을 실행합니다."
    }
  },
  {
    name: "코덱스명령",
    description: {
      en: "Send any Codex slash command.",
      ko: "임의의 Codex slash 명령을 실행합니다."
    }
  }
];

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
  void registerSlashCommands(readyClient).catch((error) => {
    console.error("Failed to register Discord slash commands", error);
  });
  void recoverRunningJobs(readyClient).catch((error) => {
    console.error("Failed to recover running Codex jobs", error);
  });
});

client.on(Events.ThreadCreate, async (thread) => {
  if (!isManagedThread(thread)) {
    return;
  }

  try {
    await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    await ensureControlPanel(thread, threadStates.get(thread.id));
    console.log(`Prepared workspace for thread ${thread.id}`);
  } catch (error) {
    console.error(`Failed to prepare workspace for thread ${thread.id}`, error);
  }
});

async function registerSlashCommands(readyClient: Client<true>): Promise<void> {
  const commands: ApplicationCommandDataResolvable[] = [
    ...slashCommandAliases.map((alias) => ({
      name: alias.name,
      description: alias.description[config.language],
      options: commandNameFromAlias(alias.name) === "shell"
        ? [{
          name: "command",
          description: config.language === "ko" ? "실행할 서버 셸 명령" : "Server shell command to run",
          type: ApplicationCommandOptionType.String as const,
          required: true
        }]
        : []
    })),
    ...codexDiscordCommandAliases.map((alias) => ({
      name: alias.name,
      description: alias.description[config.language],
      options: [{
        name: "args",
        description: config.language === "ko" ? "Codex 명령에 전달할 추가 인자" : "Additional arguments for the Codex command",
        type: ApplicationCommandOptionType.String as const,
        required: false
      }]
    })),
    ...genericCodexCommandAliases.map((alias) => ({
      name: alias.name,
      description: alias.description[config.language],
      options: [
        {
          name: "command",
          description: config.language === "ko" ? "실행할 Codex 명령 이름" : "Codex slash command name",
          type: ApplicationCommandOptionType.String as const,
          required: true
        },
        {
          name: "args",
          description: config.language === "ko" ? "Codex 명령에 전달할 추가 인자" : "Additional arguments for the Codex command",
          type: ApplicationCommandOptionType.String as const,
          required: false
        }
      ]
    }))
  ];
  const registered = await readyClient.application.commands.set(commands, config.discordGuildId);
  console.log(`Registered ${registered.size} Discord application command(s) for guild ${config.discordGuildId}`);
}

client.on(Events.MessageCreate, async (message) => {
  if (await handleParentChannelMessage(message)) {
    return;
  }

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
  await ensureControlPanel(thread, threadStates.get(thread.id));
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

  if (state?.running) {
    const queuedJob = createQueuedJob([message], prompt);
    queuedJob.prompt = formatInterruptPrompt(state.running.job, queuedJob);
    queuedJob.promptSummary = summarizePrompt(`${queuedJob.promptSummary} (follow-up)`);
    state.queue.push(queuedJob);
    state.running.interruptRequested = true;
    await persistRunningJob(state, "interrupted", "New Discord message received; pausing current work to respond.");
    state.running.abortController.abort();
    await editRunningStatus(thread, state);
    return;
  }

  const enqueueResult = enqueueThreadJob(thread.id, createQueuedJob([message], prompt));

  if (!enqueueResult.started) {
    await sendThreadStatus(thread, threadStates.get(thread.id));
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isChatInputCommand()) ||
    !interaction.guild ||
    !interaction.channel?.isThread()
  ) {
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
  if (interaction.isChatInputCommand()) {
    await handleChatInputCommandInteraction(interaction, thread);
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

function isManagedParentChannelMessage(message: Message): boolean {
  return (
    !message.author.bot &&
    message.guild?.id === config.discordGuildId &&
    !message.channel.isThread() &&
    message.channel.id === config.discordParentChannelId
  );
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

async function handleParentChannelMessage(message: Message): Promise<boolean> {
  if (!isManagedParentChannelMessage(message)) {
    return false;
  }
  if (!(await isAllowed(message))) {
    await sendParentChannelMessage(message, {
      content: messages.denied,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  const content = message.cleanContent.trim();
  if (!content) {
    return true;
  }

  const guildWorkspace = await ensureGuildWorkspace(config.baseWorkspaceDir, message.guildId ?? config.discordGuildId);
  const command = parseParentProfileCommand(content);
  if (command === "show") {
    const profile = await loadGlobalProfileState(guildWorkspace);
    await sendParentChannelMessage(message, {
      content: formatGlobalProfilePreview(profile),
      allowedMentions: { parse: [] }
    });
    return true;
  }
  if (command === "clear") {
    await clearGlobalProfileState(guildWorkspace);
    await sendParentChannelMessage(message, {
      content: messages.globalProfileCleared,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  const saved = await saveGlobalProfileState(guildWorkspace, {
    content,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    sourceMessageId: message.id
  });
  await sendParentChannelMessage(message, {
    content: messages.globalProfileSaved(formatProfilePreview(saved.content), saved.authorName, saved.updatedAt),
    allowedMentions: { parse: [] }
  });
  return true;
}

async function sendParentChannelMessage(
  message: Message,
  options: Parameters<ThreadChannel["send"]>[0]
): Promise<void> {
  if ("send" in message.channel && typeof message.channel.send === "function") {
    await message.channel.send(options);
  }
}

async function isInteractionAllowed(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction
): Promise<boolean> {
  return isUserAllowed(interaction.guild, interaction.user.id, interaction.member);
}

async function isUserAllowed(
  guild: Message["guild"],
  userId: string,
  memberLike: Message["member"] | ButtonInteraction["member"] | StringSelectMenuInteraction["member"] | ChatInputCommandInteraction["member"]
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
    attachmentCount: messages.reduce((count, message) => count + message.attachments.size, 0),
    threadId: latestMessage?.channelId ?? "unknown"
  };
}

function createQueuedJobFromInteraction(
  interaction: ChatInputCommandInteraction,
  prompt: string,
  threadId: string
): QueuedJob {
  const member = interaction.member;
  const authorName =
    member && "displayName" in member && typeof member.displayName === "string"
      ? member.displayName
      : interaction.user.username;
  return {
    id: createJobId(),
    messages: [],
    prompt,
    promptSummary: summarizePrompt(prompt),
    authorId: interaction.user.id,
    authorName,
    createdAt: Date.now(),
    messageIds: [interaction.id],
    attachmentCount: 0,
    threadId
  };
}

function createRecoveredQueuedJob(stored: StoredJobState, threadId: string): QueuedJob | undefined {
  const startedAt = Date.parse(stored.startedAt);
  const createdAt = stored.createdAt ? Date.parse(stored.createdAt) : Number.NaN;
  const prompt = buildRecoveredPrompt(stored);
  if (!prompt) {
    return undefined;
  }

  return {
    id: stored.jobId,
    messages: [],
    prompt,
    promptSummary: stored.promptSummary || summarizePrompt(prompt),
    authorId: stored.authorId ?? "unknown",
    authorName: stored.authorName ?? "unknown",
    createdAt: Number.isFinite(createdAt) ? createdAt : Number.isFinite(startedAt) ? startedAt : Date.now(),
    messageIds: stored.messageIds ?? [],
    attachmentCount: stored.attachmentCount ?? 0,
    threadId: stored.threadId ?? threadId,
    recoveredFromJobId: stored.jobId,
    persistedPrompt: stored.prompt,
    recoveryAttempts: (stored.recoveryAttempts ?? 0) + 1,
    initialProgressEvents: [
      ...(stored.progress ?? []),
      messages.recoveryQueued
    ]
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

function formatInterruptPrompt(previousJob: QueuedJob, nextJob: QueuedJob): string {
  return [
    "A new Discord message arrived while you were working.",
    "Pause the previous line of work, answer or incorporate this new message, then continue the task from the same session.",
    "",
    "Previous task summary:",
    previousJob.promptSummary,
    "",
    "New user message:",
    nextJob.prompt.trim() || messages.analyzeAttachments
  ].join("\n");
}

function buildRecoveredPrompt(stored: StoredJobState): string | undefined {
  const originalPrompt = stored.prompt?.trim();
  if (!originalPrompt && !stored.promptSummary && !stored.jobId) {
    return undefined;
  }

  return [
    "The Discord bot or service restarted while this Codex job was running.",
    "Resume naturally in the existing Codex session and current repository state.",
    "Do not repeat completed work unless verification shows it is needed.",
    "Continue the remaining work, keep commits scoped, and report progress clearly in Discord.",
    "",
    "Recovered job context:",
    `Job id: ${stored.jobId}`,
    `Previous phase: ${stored.phase}`,
    `Started: ${stored.startedAt}`,
    `Last update: ${stored.updatedAt}`,
    `Author: ${stored.authorName ?? "unknown"} (${stored.authorId ?? "unknown"})`,
    `Messages: ${(stored.messageIds ?? []).join(", ") || "unknown"}`,
    `Attachments: ${stored.attachmentCount ?? 0}`,
    "",
    originalPrompt
      ? `Original user request:\n${originalPrompt}`
      : `Original user request summary:\n${stored.promptSummary}`,
    "",
    "If the original request is already present in the resumed session, use that context as the source of truth."
  ].join("\n");
}

async function fetchThreadChannel(threadId: string): Promise<ThreadChannel | undefined> {
  const channel = await client.channels.fetch(threadId).catch(() => null);
  return channel?.isThread() ? channel : undefined;
}

async function recoverRunningJobs(readyClient: Client<true>): Promise<void> {
  const storedJobs = await listStoredThreadJobStates(config.baseWorkspaceDir, config.discordGuildId);
  let recovered = 0;
  for (const storedJob of storedJobs) {
    if (!isRecoverableStoredJob(storedJob.state)) {
      continue;
    }
    const channel = await readyClient.channels.fetch(storedJob.threadId).catch(() => null);
    if (!channel?.isThread() || !isManagedThread(channel)) {
      continue;
    }
    if (await recoverStoredJob(channel, storedJob.state, "startup")) {
      recovered += 1;
    }
  }
  if (recovered > 0) {
    console.log(`Recovered ${recovered} running Codex job(s) after startup.`);
  }
}

async function recoverStoredJob(
  thread: ThreadChannel,
  stored: StoredJobState,
  source: "startup" | "thread-activity"
): Promise<boolean> {
  const state = getThreadState(thread.id);
  if (state.running || state.queue.some((job) => job.recoveredFromJobId === stored.jobId || job.id === stored.jobId)) {
    return false;
  }

  const recoveredJob = createRecoveredQueuedJob(stored, thread.id);
  if (!recoveredJob) {
    return false;
  }

  console.log(`Recovering Codex job ${stored.jobId} for thread ${thread.id} from ${source}.`);
  enqueueThreadJob(thread.id, recoveredJob);
  await ensureControlPanel(thread, threadStates.get(thread.id));
  return true;
}

function isRecoverableStoredJob(stored: StoredJobState | undefined): stored is StoredJobState {
  if (!stored) {
    return false;
  }
  if (stored.status === "running") {
    return true;
  }
  if (stored.status === "interrupted" && stored.error === "The service stopped before this job completed.") {
    return true;
  }
  return stored.status === "failed" &&
    (stored.recoveryAttempts ?? 0) < 1 &&
    typeof stored.error === "string" &&
    stored.error.includes("Codex produced no output");
}

function parseParentProfileCommand(content: string): "show" | "clear" | undefined {
  const normalized = content.trim().toLowerCase();
  if (["profile", "/profile", "프로필", "/프로필"].includes(normalized)) {
    return "show";
  }
  if (["profile clear", "clear profile", "/profile clear", "프로필 초기화", "/프로필 초기화"].includes(normalized)) {
    return "clear";
  }
  return undefined;
}

function formatGlobalProfilePreview(profile: GlobalProfileState | undefined): string {
  if (!profile) {
    return messages.globalProfileEmpty;
  }
  return messages.globalProfileCurrent(
    formatProfilePreview(profile.content),
    profile.authorName,
    profile.updatedAt
  );
}

function formatProfilePreview(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
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
    threadId: first.threadId,
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
    lastEvent: job.recoveredFromJobId ? messages.recoveryStarted : "Job accepted.",
    timeoutAt: config.codexRunTimeoutMs ? Date.now() + config.codexRunTimeoutMs : undefined,
    idleDeadlineAt: config.codexIdleTimeoutMs ? Date.now() + config.codexIdleTimeoutMs : undefined,
    abortController,
    progressEvents: [...(job.initialProgressEvents ?? []), job.recoveredFromJobId ? messages.recoveryStarted : "Job accepted."],
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
  const thread = latestMessage?.channel as ThreadChannel | undefined ?? await fetchThreadChannel(job.threadId);
  if (!thread) {
    return;
  }

  const stopTyping = startTyping(thread);
  const startedAt = Date.now();
  let refreshStatus: ReturnType<typeof setInterval> | undefined;
  let liveStatusEdit: ReturnType<typeof setTimeout> | undefined;

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
    const globalProfile = await loadGlobalProfileState(await ensureGuildWorkspace(config.baseWorkspaceDir, thread.guildId));
    const prompt = buildCodexPrompt({
      userPrompt: job.prompt || messages.analyzeAttachments,
      attachmentPrompt,
      replyInstruction: messages.replyInstruction,
      globalProfile: globalProfile?.content
    });

    const statusMessage = await sendThreadMessage(thread, {
      embeds: [formatRunStartEmbed({
        jobId: job.id,
        workspaceDir: displayWorkspacePath(thread.id, workspace.dir),
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        sessionId,
        queued: state.queue.length,
        progress: state.running?.progressEvents,
        warning: buildOperationalWarning()
      }, config.language)],
      components: runningComponents(),
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "job.start", threadId: thread.id, jobId: job.id, phase: "preparing" });
    if (state.running) {
      state.running.statusMessage = statusMessage;
    }
    await editRunningStatus(thread, state);

    const scheduleLiveStatusEdit = (force = false): void => {
      if (!state.running?.statusMessage) {
        return;
      }
      if (force) {
        if (liveStatusEdit) {
          clearTimeout(liveStatusEdit);
          liveStatusEdit = undefined;
        }
        void editRunningStatus(thread, state);
        return;
      }
      if (liveStatusEdit) {
        return;
      }
      liveStatusEdit = setTimeout(() => {
        liveStatusEdit = undefined;
        void editRunningStatus(thread, state);
      }, 1_000);
      liveStatusEdit.unref();
    };

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

    await persistRunningJob(state, "codex", "Codex process started.");
    await editRunningStatus(thread, state);
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
        void persistRunningJob(state, event.phase, event.summary)
          .then(() => scheduleLiveStatusEdit());
      },
      onUsage: (usage) => {
        if (state.running) {
          state.running.usage = usage;
        }
        void saveUsageState(workspace, usage).catch((error) => {
          console.warn("Failed to persist Codex usage state", error);
        });
      },
      onResponseSnapshot: (content) => {
        if (state.running) {
          state.running.codexResponse = formatCodexResponse(stripHiddenPromptContent(content), config.language);
        }
      },
      onTranscriptSnapshot: (content) => {
        if (state.running) {
          state.running.codexTranscript = content;
        }
        scheduleLiveStatusEdit();
      }
    });

    if (result.sessionId) {
      await saveSessionId(workspace, result.sessionId, result.sessionLogPath ?? sessionState?.sessionLogPath);
    }
    if (result.usage) {
      await saveUsageState(workspace, result.usage);
    }
    const codexResponse = formatCodexResponse(stripHiddenPromptContent(result.content), config.language);
    if (state.running) {
      state.running.codexResponse = codexResponse;
    }
    await sendCodexResponse(thread, codexResponse, job.id);

    await persistRunningJob(state, "completed", "Codex job completed.", "completed");
    scheduleLiveStatusEdit(true);

    if (state.running?.statusMessage) {
      const stats = await getWorkspaceStats(workspace);
      await editDiscordMessage(state.running.statusMessage, {
        embeds: [formatRunCompleteEmbed({
          elapsedMs: Date.now() - startedAt,
          sessionId: result.sessionId ?? sessionId,
          files: stats.files,
          bytes: stats.bytes,
          usage: result.usage ?? state.running.usage,
          progress: state.running.progressEvents,
          transcript: buildCodexTranscriptOutput(state.running)
        }, config.language)],
        components: idleComponents(),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "job.complete.edit", threadId: thread.id, jobId: job.id, phase: "completed" });
    }
  } catch (error) {
    const running = state.running;
    if (running?.interruptRequested) {
      console.log(`Codex run interrupted for new user input in thread ${thread.id}`);
      await persistRunningJob(state, "interrupted", "Paused for a new Discord message.", "running");
      if (running.statusMessage) {
        await editDiscordMessage(running.statusMessage, {
          embeds: [buildStatusEmbed(state, true)],
          components: runningComponents(),
          allowedMentions: { parse: [] }
        }, discordApiOptions(), { action: "job.interrupted.edit", threadId: thread.id, jobId: running.id, phase: "interrupted" })
          .catch(() => undefined);
      }
      return;
    }
    if (running?.stopRequested) {
      console.log(`Codex run stopped by user request for thread ${thread.id}`);
      await persistRunningJob(state, "stopped", "Codex job stopped.", "stopped");
      if (running.statusMessage) {
        await editDiscordMessage(running.statusMessage, {
          embeds: [formatRunStoppedEmbed({
            elapsedMs: Date.now() - startedAt,
            transcript: buildCodexTranscriptOutput(running)
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
            lastEvent: running.lastEvent,
            error: error instanceof Error ? error.message : String(error),
            transcript: buildCodexTranscriptOutput(running)
          }, config.language)],
        components: failedComponents(),
        allowedMentions: { parse: [] }
      }, discordApiOptions(), { action: "job.failed.edit", threadId: thread.id, jobId: running.id, phase: "failed" })
        .catch(() => undefined);
    }
  } finally {
    if (refreshStatus) {
      clearInterval(refreshStatus);
    }
    if (liveStatusEdit) {
      clearTimeout(liveStatusEdit);
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
      await ensureControlPanel(thread, state);
      return;
    case "settings":
      await sendThreadSettings(thread);
      return;
    case "queue":
      await sendThreadQueue(thread, state);
      return;
    case "doctor":
      await sendThreadDoctor(thread);
      return;
    case "usage":
      await sendThreadUsage(thread, state);
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
    case "shell":
      await handleShellCommand(thread, command.rawArgs ?? command.args.join(" "));
      return;
  }
}

async function handleShellCommand(thread: ThreadChannel, commandText: string): Promise<void> {
  const command = commandText.trim();
  if (isAllowlistOpen()) {
    await sendThreadMessage(thread, {
      content: shellCommandDeniedMessage(),
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "command.shell.denied", threadId: thread.id });
    return;
  }
  if (!command) {
    await sendThreadMessage(thread, {
      content: config.language === "ko"
        ? "사용법: `/터미널 <명령>` 또는 `/shell <command>`"
        : "Usage: `/shell <command>` or `/terminal <command>`",
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "command.shell.usage", threadId: thread.id });
    return;
  }

  await sendThreadTyping(thread, discordApiOptions(), { action: "command.shell.typing", threadId: thread.id });
  const statusMessage = await sendThreadMessage(thread, {
    embeds: [formatShellCommandEmbed({
      command,
      cwd: process.cwd(),
      durationMs: 0,
      output: "",
      timedOut: false,
      truncated: false
    }, "running")],
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "command.shell.start", threadId: thread.id });
  let lastEditAt = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | undefined;
  let queuedSnapshot: ShellCommandSnapshot | undefined;

  const editShellEmbed = (snapshot: ShellCommandSnapshot, force = false): void => {
    const now = Date.now();
    const elapsed = now - lastEditAt;
    if (!force && elapsed < 1_000) {
      queuedSnapshot = snapshot;
      if (!pendingEdit) {
        pendingEdit = setTimeout(() => {
          pendingEdit = undefined;
          if (queuedSnapshot) {
            editShellEmbed(queuedSnapshot, true);
            queuedSnapshot = undefined;
          }
        }, 1_000 - elapsed);
        pendingEdit.unref();
      }
      return;
    }
    lastEditAt = now;
    void editDiscordMessage(statusMessage, {
      embeds: [formatShellCommandEmbed(snapshot, "running")],
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "command.shell.update", threadId: thread.id }).catch(() => undefined);
  };

  const result = await runShellCommand(command, {
    cwd: process.cwd(),
    timeoutMs: config.shellCommandTimeoutMs,
    maxOutputBytes: config.shellCommandMaxOutputBytes,
    env: process.env,
    onOutput: editShellEmbed
  });
  if (pendingEdit) {
    clearTimeout(pendingEdit);
  }
  await editDiscordMessage(statusMessage, {
    embeds: [formatShellCommandEmbed(result, result.blockedReason ? "blocked" : "complete")],
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "command.shell.complete", threadId: thread.id });
}

async function notifyInterruptedIfAny(thread: ThreadChannel): Promise<void> {
  const state = threadStates.get(thread.id);
  if (state?.running) {
    return;
  }
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const stored = await loadJobState(workspace);
  if (isRecoverableStoredJob(stored) && await recoverStoredJob(thread, stored, "thread-activity")) {
    return;
  }
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
    case "codex:doctor":
      await sendThreadDoctor(thread);
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.doctor",
        threadId: thread.id
      });
      return;
    case "codex:usage":
      await sendThreadUsage(thread, state);
      await replyToInteraction(interaction, { content: messages.statusRefreshed, ephemeral: true }, discordApiOptions(), {
        action: "button.usage",
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

async function handleChatInputCommandInteraction(
  interaction: ChatInputCommandInteraction,
  thread: ThreadChannel
): Promise<void> {
  if (
    interaction.commandName !== "codex" &&
    !commandNameFromAlias(interaction.commandName) &&
    !codexDiscordCommandFromAlias(interaction.commandName) &&
    !genericCodexCommandAliases.some((alias) => alias.name === interaction.commandName)
  ) {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const codexPrompt = codexPromptFromInteraction(interaction);
  if (codexPrompt) {
    await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    await ensureControlPanel(thread, threadStates.get(thread.id));
    await notifyInterruptedIfAny(thread);
    await enqueueInteractionPrompt(thread, interaction, codexPrompt);
    await interaction.editReply(messages.commandHandled);
    return;
  }

  const command = parseChatInputCommand(interaction);
  await handleThreadCommand(thread, command);
  await interaction.editReply(messages.commandHandled);
}

async function enqueueInteractionPrompt(
  thread: ThreadChannel,
  interaction: ChatInputCommandInteraction,
  prompt: string
): Promise<void> {
  const state = threadStates.get(thread.id);
  const job = createQueuedJobFromInteraction(interaction, prompt, thread.id);
  if (state?.running) {
    job.prompt = formatInterruptPrompt(state.running.job, job);
    job.promptSummary = summarizePrompt(`${job.promptSummary} (follow-up)`);
    state.queue.push(job);
    state.running.interruptRequested = true;
    await persistRunningJob(state, "interrupted", "New Discord command received; pausing current work to respond.");
    state.running.abortController.abort();
    await editRunningStatus(thread, state);
    return;
  }

  const enqueueResult = enqueueThreadJob(thread.id, job);
  if (!enqueueResult.started) {
    await sendThreadStatus(thread, threadStates.get(thread.id));
  }
}

function parseChatInputCommand(interaction: ChatInputCommandInteraction): ThreadCommand {
  const topLevel = commandNameFromAlias(interaction.commandName);
  if (topLevel) {
    const rawArgs = firstStringOptionValue(interaction.options.data);
    return rawArgs ? { name: topLevel, args: rawArgs.split(/\s+/).filter(Boolean), rawArgs } : { name: topLevel, args: [] };
  }
  const subcommand = interaction.options.getSubcommand(false);
  const commandText = subcommand ?? firstStringOptionValue(interaction.options.data) ?? "help";

  return parseThreadCommand(commandText) ?? parseThreadCommand(`/codex ${commandText}`) ?? { name: "help", args: [] };
}

function codexPromptFromInteraction(interaction: ChatInputCommandInteraction): string | undefined {
  const directCommand = codexDiscordCommandFromAlias(interaction.commandName);
  if (directCommand) {
    return buildCodexSlashPrompt(directCommand.canonical, interaction.options.getString("args") ?? "");
  }
  if (genericCodexCommandAliases.some((alias) => alias.name === interaction.commandName)) {
    const command = interaction.options.getString("command", true);
    const args = interaction.options.getString("args") ?? "";
    return buildCodexSlashPrompt(command, args);
  }
  return undefined;
}

function firstStringOptionValue(options: readonly { value?: unknown; options?: readonly { value?: unknown; options?: readonly unknown[] }[] }[]): string | undefined {
  for (const option of options) {
    if (typeof option.value === "string" && option.value.trim().length > 0) {
      return option.value.trim();
    }
    if (Array.isArray(option.options)) {
      const nested = firstStringOptionValue(option.options as Parameters<typeof firstStringOptionValue>[0]);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
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
      new ButtonBuilder().setCustomId("codex:stop-current").setLabel(messages.actions.stopCurrent).setStyle(ButtonStyle.Danger)
    )
  ];
}

function failedComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("codex:retry").setLabel(messages.actions.retry).setStyle(ButtonStyle.Primary)
    )
  ];
}

function idleComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [];
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
    runTimeoutAt: running?.timeoutAt,
    idleTimeoutAt: running?.idleDeadlineAt,
    elapsedMs: running ? Date.now() - running.startedAt : undefined,
    idleMs: running ? Date.now() - running.lastActivityAt : undefined,
    queued: state.queue.length,
    queueSummary: formatQueueSummary(state.queue),
    usage: running?.usage,
    progress: running?.progressEvents,
    transcript: running ? buildCodexTranscriptOutput(running) : undefined,
    warning: buildOperationalWarning()
  }, config.language);
}

async function sendCodexResponse(thread: ThreadChannel, response: string, jobId: string): Promise<void> {
  if (shouldSendAsFile(response, config.language)) {
    const attachment = new AttachmentBuilder(Buffer.from(response, "utf8"), {
      name: `codex-response-${jobId}.md`
    });
    await sendThreadMessage(thread, {
      content: summarizeLongResponse(response, config.language),
      files: [attachment],
      allowedMentions: { parse: [] }
    }, discordApiOptions(), { action: "job.response.file", threadId: thread.id, jobId });
    return;
  }

  const chunks = prefixChunks(splitDiscordMessage(response, undefined, config.language));
  for (const [index, chunk] of chunks.entries()) {
    await sendThreadMessage(thread, {
      content: chunk,
      allowedMentions: { parse: [] }
    }, discordApiOptions(), {
      action: "job.response.send",
      threadId: thread.id,
      jobId,
      phase: chunks.length > 1 ? `chunk-${index + 1}` : undefined
    });
  }
}

function buildCodexTranscriptOutput(running: RunningJob): string | undefined {
  const transcript = latestTranscriptEntries(stripHiddenPromptContent(running.codexTranscript ?? ""), 3);
  return transcript.length > 0 ? transcript.join("\n\n") : undefined;
}

function latestTranscriptEntries(transcript: string, count: number): string[] {
  return transcript
    .split(/\n{2,}(?=• )/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(-count);
}

async function buildIdleStatusEmbed(thread: ThreadChannel, state: ThreadState | undefined) {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const lastJob = await loadJobState(workspace);
  return formatStatusEmbed({
    running: false,
    jobId: lastJob?.jobId,
    phase: lastJob?.status,
    lastEvent: lastJob?.status === "running" ? messages.recoveryQueued : lastJob?.status === "interrupted" ? messages.interruptedHint : lastJob?.error,
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
  pushProgressEvent(running, lastEvent);
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
    prompt: running.job.persistedPrompt ?? running.job.prompt,
    threadId: running.job.threadId,
    authorId: running.job.authorId,
    authorName: running.job.authorName,
    createdAt: new Date(running.job.createdAt).toISOString(),
    startedAt: new Date(running.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: status === "running" ? undefined : new Date().toISOString(),
    error: status === "failed" ? lastEvent : undefined,
    queued: state.queue.length,
    messageIds: running.job.messageIds,
    attachmentCount: running.job.attachmentCount,
    progress: running.progressEvents,
    recoveryAttempts: running.job.recoveryAttempts,
    usage: running.usage
  });
}

function pushProgressEvent(running: RunningJob, event: string): void {
  const normalized = event.trim().replace(/\s+/g, " ");
  if (!normalized || running.progressEvents.at(-1) === normalized) {
    return;
  }
  running.progressEvents.push(normalized);
  if (running.progressEvents.length > 20) {
    running.progressEvents.splice(0, running.progressEvents.length - 20);
  }
}

async function editRunningStatus(thread: ThreadChannel, state: ThreadState): Promise<void> {
  const running = state.running;
  if (!running?.statusMessage) {
    return;
  }
  await editDiscordMessage(running.statusMessage, {
    embeds: [buildStatusEmbed(state, true)],
    components: runningComponents(),
    allowedMentions: { parse: [] }
  }, discordApiOptions(), {
    action: "job.status.edit",
    threadId: thread.id,
    jobId: running.id,
    phase: running.phase
  }).catch(() => undefined);
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

async function ensureControlPanel(thread: ThreadChannel, state: ThreadState | undefined): Promise<Message> {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const embed = state?.running
    ? formatControlPanelEmbed({
      running: true,
      jobId: state.running.id,
      phase: state.running.phase,
      lastEvent: state.running.lastEvent,
      queued: state.queue.length,
      queueSummary: formatQueueSummary(state.queue),
      progress: state.running.progressEvents,
      warning: buildOperationalWarning()
    }, config.language)
    : formatControlPanelEmbed({
      running: false,
      queued: state?.queue.length ?? 0,
      queueSummary: formatQueueSummary(state?.queue ?? []),
      warning: buildOperationalWarning()
    }, config.language);

  const options = {
    embeds: [embed],
    components: state?.running ? runningComponents() : idleComponents(),
    allowedMentions: { parse: [] }
  };
  const storedPanel = await loadPanelState(workspace);
  if (storedPanel) {
    const existing = await thread.messages.fetch(storedPanel.messageId).catch(() => undefined);
    if (existing) {
      const updated = await editDiscordMessage(existing, options, discordApiOptions(), {
        action: "panel.edit",
        threadId: thread.id,
        jobId: state?.running?.id,
        phase: state?.running?.phase
      });
      await pinControlPanel(updated);
      return updated;
    }
  }

  const pinnedPanel = await findPinnedControlPanel(thread);
  if (pinnedPanel) {
    const updated = await editDiscordMessage(pinnedPanel, options, discordApiOptions(), {
      action: "panel.pinned.edit",
      threadId: thread.id,
      jobId: state?.running?.id,
      phase: state?.running?.phase
    });
    await savePanelState(workspace, updated.id);
    await pinControlPanel(updated);
    return updated;
  }

  const created = await sendThreadMessage(thread, options, discordApiOptions(), {
    action: "panel.send",
    threadId: thread.id,
    jobId: state?.running?.id,
    phase: state?.running?.phase
  });
  await savePanelState(workspace, created.id);
  await pinControlPanel(created);
  return created;
}

async function findPinnedControlPanel(thread: ThreadChannel): Promise<Message | undefined> {
  const pinned = await thread.messages.fetchPinned().catch(() => undefined);
  const titles = new Set(["Codex control panel", "Codex 컨트롤 패널", plainPanelTitle()]);
  return pinned?.find((message) =>
    message.author.id === client.user?.id &&
    message.embeds.some((embed) => embed.title ? titles.has(embed.title) : false)
  );
}

async function pinControlPanel(message: Message): Promise<void> {
  if (message.pinned) {
    return;
  }
  await message.pin("Codex control panel").catch((error) => {
    console.warn("Failed to pin Codex control panel", {
      threadId: message.channelId,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function plainPanelTitle(): string {
  return messages.panelTitle.replace(/^\*\*/, "").replace(/\*\*$/, "");
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

async function sendThreadDoctor(thread: ThreadChannel): Promise<void> {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  const checks = await runDoctor(config, workspace);
  await sendThreadMessage(thread, {
    embeds: [formatDoctorEmbed(checks, config.language)],
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "doctor.send", threadId: thread.id });
}

async function sendThreadUsage(thread: ThreadChannel, state: ThreadState | undefined): Promise<void> {
  const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
  await sendThreadMessage(thread, {
    embeds: [formatUsageEmbed(state?.running?.usage ?? await loadUsageState(workspace), config.language)],
    allowedMentions: { parse: [] }
  }, discordApiOptions(), { action: "usage.send", threadId: thread.id });
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

function shellCommandDeniedMessage(): string {
  return config.language === "ko"
    ? [
      "**서버 셸 명령 거부됨**",
      "Discord 허용 목록이 설정되어 있지 않아 셸 명령을 실행하지 않았습니다.",
      "`DISCORD_ALLOWED_USER_IDS` 또는 `DISCORD_ALLOWED_ROLE_IDS`를 설정하세요."
    ].join("\n")
    : [
      "**Server shell command denied**",
      "Shell commands are disabled while the Discord allowlist is open.",
      "Set `DISCORD_ALLOWED_USER_IDS` or `DISCORD_ALLOWED_ROLE_IDS`."
    ].join("\n");
}

function inlineCode(value: string): string {
  return value.replace(/`/g, "'");
}

function escapeCodeFence(value: string): string {
  return value.replace(/```/g, "'''");
}

function formatShellDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatShellCommandEmbed(
  result: ShellCommandSnapshot | ShellCommandResult,
  phase: "running" | "complete" | "blocked"
): { title: string; description: string; color: number; timestamp: string } {
  const isKorean = config.language === "ko";
  const blockedReason = "blockedReason" in result ? result.blockedReason : undefined;
  const status = blockedReason
    ? isKorean ? "차단됨" : "blocked"
    : phase === "running"
      ? isKorean ? "실행 중" : "running"
      : shellExitStatus(result);
  const output = blockedReason
    ? blockedReason
    : result.output.trim() || (phase === "running" ? isKorean ? "출력을 기다리는 중..." : "Waiting for output..." : isKorean ? "(출력 없음)" : "(no output)");
  const omitted = result.truncated || escapeCodeFence(output).length > 3_200;
  const header = [
    `${isKorean ? "명령" : "Command"}: \`${inlineCode(clip(result.command, 320))}\``,
    `${isKorean ? "상태" : "Status"}: \`${status}\``,
    `${isKorean ? "시간" : "Duration"}: \`${formatShellDuration(result.durationMs)}\``,
    "",
    "```text"
  ].join("\n");
  const footer = `\n\`\`\`${result.truncated ? isKorean ? "\n_출력 수집 한도에 도달했습니다._" : "\n_Output capture limit reached._" : ""}`;
  const outputBody = tailForEmbed(escapeCodeFence(output), 4096 - header.length - footer.length);

  return {
    title: isKorean ? "서버 셸 명령" : "Server shell command",
    description: `${header}\n${outputBody}${footer}`,
    color: shellEmbedColor(result, phase),
    timestamp: new Date().toISOString()
  };
}

function shellExitStatus(result: ShellCommandSnapshot | ShellCommandResult): string {
  if (result.timedOut) {
    return "timeout";
  }
  if ("signal" in result && result.signal) {
    return `signal ${result.signal}`;
  }
  if ("exitCode" in result) {
    return `exit ${result.exitCode ?? "unknown"}`;
  }
  return "running";
}

function shellEmbedColor(result: ShellCommandSnapshot | ShellCommandResult, phase: "running" | "complete" | "blocked"): number {
  if (phase === "blocked" || result.timedOut || ("exitCode" in result && result.exitCode !== 0)) {
    return 0xeb5757;
  }
  if (phase === "complete") {
    return 0x27ae60;
  }
  return 0x2f80ed;
}

function tailForEmbed(value: string, limit: number): string {
  const safeLimit = Math.max(200, limit);
  if (value.length <= safeLimit) {
    return value;
  }
  return value.slice(value.length - safeLimit).replace(/^[^\n]*\n?/, "");
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}
