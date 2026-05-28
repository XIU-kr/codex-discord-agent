import { t, type BotLanguage } from "./i18n";

export const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_CHUNK_LIMIT = 1900;
const FILE_RESPONSE_THRESHOLD = 8_000;
const embedColors = {
  running: 0x2f80ed,
  complete: 0x27ae60,
  failed: 0xeb5757,
  neutral: 0x5865f2
} as const;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
}

export function splitDiscordMessage(input: string, limit = DEFAULT_CHUNK_LIMIT, language: BotLanguage = "en"): string[] {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [t(language).emptyResponse];
  }

  const chunks: string[] = [];
  const lines = normalized.split("\n");
  let current = "";
  let activeFenceLang: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const isLast = index === lines.length - 1;
    const line = lines[index] ?? "";
    const piece = `${line}${isLast ? "" : "\n"}`;

    if (piece.length > limit) {
      flushChunk();
      for (const hardChunk of splitLongPiece(piece, limit, activeFenceLang)) {
        chunks.push(hardChunk);
      }
      updateFence(line);
      continue;
    }

    const reservedFenceClose = activeFenceLang ? "\n```".length : 0;
    if (current.length + piece.length + reservedFenceClose > limit) {
      flushChunk();
    }

    current += piece;
    updateFence(line);
  }

  flushChunk();
  return chunks;

  function flushChunk(): void {
    const body = current.trimEnd();
    if (!body) {
      current = activeFenceLang ? `\`\`\`${activeFenceLang}\n` : "";
      return;
    }

    chunks.push(activeFenceLang ? `${body}\n\`\`\`` : body);
    current = activeFenceLang ? `\`\`\`${activeFenceLang}\n` : "";
  }

  function updateFence(line: string): void {
    const match = line.match(/^```(\S*)?/);
    if (!match) {
      return;
    }
    activeFenceLang = activeFenceLang ? undefined : match[1] ?? "";
  }
}

export function shouldSendAsFile(input: string, language: BotLanguage = "en"): boolean {
  return input.length > FILE_RESPONSE_THRESHOLD || splitDiscordMessage(input, DEFAULT_CHUNK_LIMIT, language).length > 5;
}

export function prefixChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => `**(${index + 1}/${chunks.length})**\n${chunk}`);
}

export function formatCodexResponse(content: string, language: BotLanguage = "en"): string {
  const normalized = content.trim();
  if (!normalized) {
    return t(language).emptyResponse;
  }

  if (hasStructuredHeadings(normalized)) {
    return normalized;
  }

  return `${t(language).responseTitle}\n${normalized}`;
}

export function formatRunHeader(options: {
  workspaceDir: string;
  model: string;
  reasoningEffort: string;
  sessionId?: string;
  queued: number;
}, language: BotLanguage = "en"): string {
  const messages = t(language);
  return [
    messages.runStart,
    `${messages.labels.workspace}: \`${options.workspaceDir}\``,
    `${messages.labels.model}: \`${options.model}\` / ${messages.labels.reasoning}: \`${options.reasoningEffort}\``,
    `${messages.labels.session}: \`${options.sessionId ?? messages.values.newSession}\``,
    `${messages.labels.queued}: \`${options.queued}\``
  ].join("\n");
}

export function formatRunComplete(options: {
  elapsedMs: number;
  sessionId?: string;
  files?: number;
  bytes?: number;
}, language: BotLanguage = "en"): string {
  const messages = t(language);
  const lines = [
    messages.runComplete,
    `${messages.labels.elapsed}: \`${formatDuration(options.elapsedMs, language)}\``,
    `${messages.labels.session}: \`${options.sessionId ?? messages.values.unknown}\``
  ];

  if (typeof options.files === "number" && typeof options.bytes === "number") {
    lines.push(`${messages.labels.workspace}: \`${messages.values.files(options.files)} / ${formatBytes(options.bytes)}\``);
  }

  return lines.join("\n");
}

export function formatRunStartEmbed(options: {
  jobId?: string;
  workspaceDir: string;
  model: string;
  reasoningEffort: string;
  sessionId?: string;
  queued: number;
  warning?: string;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  const fields: DiscordEmbedField[] = [
    { name: messages.labels.workspace, value: code(options.workspaceDir) },
    { name: messages.labels.model, value: code(options.model), inline: true },
    { name: messages.labels.reasoning, value: code(options.reasoningEffort), inline: true },
    { name: messages.labels.session, value: code(options.sessionId ?? messages.values.newSession), inline: true },
    { name: messages.labels.queued, value: code(String(options.queued)), inline: true }
  ];
  if (options.jobId) {
    fields.unshift({ name: messages.labels.job, value: code(options.jobId), inline: true });
  }

  return {
    title: plainTitle(messages.runStart),
    description: options.warning,
    color: embedColors.running,
    timestamp: new Date().toISOString(),
    fields
  };
}

export function formatRunCompleteEmbed(options: {
  elapsedMs: number;
  sessionId?: string;
  files?: number;
  bytes?: number;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  const fields: DiscordEmbedField[] = [
    { name: messages.labels.elapsed, value: code(formatDuration(options.elapsedMs, language)), inline: true },
    { name: messages.labels.session, value: code(options.sessionId ?? messages.values.unknown), inline: true }
  ];

  if (typeof options.files === "number" && typeof options.bytes === "number") {
    fields.push({
      name: messages.labels.workspace,
      value: code(`${messages.values.files(options.files)} / ${formatBytes(options.bytes)}`)
    });
  }

  return {
    title: plainTitle(messages.runComplete),
    color: embedColors.complete,
    timestamp: new Date().toISOString(),
    fields
  };
}

export function formatRunFailedEmbed(options: {
  elapsedMs: number;
  lastEvent?: string;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  const fields: DiscordEmbedField[] = [
    { name: messages.labels.elapsed, value: code(formatDuration(options.elapsedMs, language)), inline: true }
  ];
  if (options.lastEvent) {
    fields.push({ name: messages.labels.lastEvent, value: code(options.lastEvent) });
  }

  return {
    title: plainTitle(messages.runFailed),
    color: embedColors.failed,
    timestamp: new Date().toISOString(),
    fields
  };
}

export function formatRunStoppedEmbed(options: {
  elapsedMs: number;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  return {
    title: plainTitle(messages.runStopped),
    color: embedColors.neutral,
    timestamp: new Date().toISOString(),
    fields: [
      { name: messages.labels.elapsed, value: code(formatDuration(options.elapsedMs, language)), inline: true }
    ]
  };
}

export function formatRunRestartedEmbed(options: {
  elapsedMs: number;
  queued: number;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  return {
    title: plainTitle(messages.runRestarted),
    color: embedColors.running,
    timestamp: new Date().toISOString(),
    fields: [
      { name: messages.labels.elapsed, value: code(formatDuration(options.elapsedMs, language)), inline: true },
      { name: messages.labels.queued, value: code(String(options.queued)), inline: true }
    ]
  };
}

export function formatStatusEmbed(options: {
  running: boolean;
  jobId?: string;
  phase?: string;
  lastEvent?: string;
  timeoutAt?: number;
  elapsedMs?: number;
  idleMs?: number;
  queued: number;
  queueSummary?: string;
  warning?: string;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  const fields: DiscordEmbedField[] = [
    { name: messages.labels.running, value: code(options.running ? messages.values.yes : messages.values.no), inline: true },
    { name: messages.labels.queued, value: code(String(options.queued)), inline: true }
  ];

  if (options.jobId) {
    fields.unshift({ name: messages.labels.job, value: code(options.jobId), inline: true });
  }
  if (options.phase) {
    fields.push({ name: messages.labels.phase, value: code(phaseLabel(options.phase, language)), inline: true });
  }
  if (typeof options.elapsedMs === "number") {
    fields.push({
      name: messages.labels.elapsed,
      value: code(formatDuration(options.elapsedMs, language)),
      inline: true
    });
  }
  if (typeof options.idleMs === "number") {
    fields.push({
      name: messages.labels.idle,
      value: code(formatDuration(options.idleMs, language)),
      inline: true
    });
  }
  if (typeof options.timeoutAt === "number") {
    fields.push({
      name: messages.labels.nextStop,
      value: code(formatDuration(Math.max(0, options.timeoutAt - Date.now()), language)),
      inline: true
    });
  }
  if (options.lastEvent) {
    fields.push({ name: messages.labels.lastEvent, value: code(options.lastEvent) });
  }
  if (options.queueSummary) {
    fields.push({ name: messages.labels.queue, value: options.queueSummary });
  }

  return {
    title: plainTitle(messages.statusTitle),
    description: options.warning,
    color: options.running ? embedColors.running : embedColors.neutral,
    timestamp: new Date().toISOString(),
    fields
  };
}

export function formatControlPanelEmbed(options: {
  running: boolean;
  jobId?: string;
  phase?: string;
  lastEvent?: string;
  queued: number;
  queueSummary?: string;
  warning?: string;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  const status = formatStatusEmbed(options, language);
  return {
    ...status,
    title: plainTitle(messages.panelTitle),
    description: [messages.panelIntro, options.warning].filter(Boolean).join("\n\n")
  };
}

export function formatWorkspaceEmbed(options: {
  path: string;
  sessionId?: string;
  files: number;
  bytes: number;
  updatedAt?: Date;
  warning?: string;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  return {
    title: plainTitle(messages.workspaceTitle),
    description: options.warning,
    color: embedColors.neutral,
    timestamp: new Date().toISOString(),
    fields: [
      { name: messages.labels.path, value: code(options.path) },
      { name: messages.labels.session, value: code(options.sessionId ?? messages.values.none), inline: true },
      { name: messages.labels.size, value: code(`${messages.values.files(options.files)} / ${formatBytes(options.bytes)}`), inline: true },
      { name: messages.labels.updated, value: code(options.updatedAt?.toISOString() ?? messages.values.unknown) }
    ]
  };
}

export function formatSettingsEmbed(options: {
  model: string;
  reasoningEffort: string;
  hideWorkspacePaths: boolean;
  includeAttachments: boolean;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  return {
    title: plainTitle(messages.settingsTitle),
    color: embedColors.neutral,
    timestamp: new Date().toISOString(),
    fields: [
      { name: messages.labels.model, value: code(options.model), inline: true },
      { name: messages.labels.reasoning, value: code(options.reasoningEffort), inline: true },
      {
        name: messages.labels.hidePaths,
        value: code(options.hideWorkspacePaths ? messages.values.enabled : messages.values.disabled),
        inline: true
      },
      {
        name: messages.labels.attachments,
        value: code(options.includeAttachments ? messages.values.enabled : messages.values.disabled),
        inline: true
      }
    ]
  };
}

export function formatQueueEmbed(options: {
  jobs: Array<{
    id: string;
    authorName: string;
    promptSummary: string;
    createdAt: number;
    attachmentCount: number;
  }>;
  selectedJobId?: string;
}, language: BotLanguage = "en"): DiscordEmbed {
  const messages = t(language);
  const fields: DiscordEmbedField[] = [
    { name: messages.labels.queued, value: code(String(options.jobs.length)), inline: true }
  ];

  const selected = options.jobs.find((job) => job.id === options.selectedJobId);
  if (selected) {
    fields.push({ name: messages.labels.selected, value: code(selected.id), inline: true });
  }

  if (options.jobs.length > 0) {
    fields.push({
      name: messages.labels.queue,
      value: options.jobs.slice(0, 10).map((job, index) => [
        `**${index + 1}. ${escapeMarkdown(job.promptSummary)}**`,
        `${messages.labels.author}: ${escapeMarkdown(job.authorName)}`,
        `${messages.labels.created}: ${code(new Date(job.createdAt).toISOString())}`,
        `${messages.labels.attachments}: ${code(String(job.attachmentCount))}`
      ].join("\n")).join("\n\n")
    });
  }

  return {
    title: plainTitle(messages.queueTitle),
    description: options.jobs.length === 0 ? messages.queueEmpty : undefined,
    color: embedColors.neutral,
    timestamp: new Date().toISOString(),
    fields
  };
}

export function formatDuration(ms: number, language: BotLanguage = "en"): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (language === "ko") {
    if (seconds < 60) {
      return `${seconds}초`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}분 ${remainingSeconds}초`;
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift() ?? "KB";
  while (value >= 1024 && units.length > 0) {
    value /= 1024;
    unit = units.shift() ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function splitLongPiece(piece: string, limit: number, activeFenceLang: string | undefined): string[] {
  const chunks: string[] = [];
  const prefix = activeFenceLang ? `\`\`\`${activeFenceLang}\n` : "";
  const suffix = activeFenceLang ? "\n```" : "";
  const available = limit - prefix.length - suffix.length;

  for (let offset = 0; offset < piece.length; offset += available) {
    const body = piece.slice(offset, offset + available).trimEnd();
    if (body.length > 0) {
      chunks.push(`${prefix}${body}${suffix}`);
    }
  }

  return chunks;
}

export function formatError(error: unknown, language: BotLanguage = "en"): string {
  const message = error instanceof Error ? error.message : String(error);
  const clipped = message.length > 1500 ? `${message.slice(0, 1500)}...` : message;
  const messages = t(language);
  if (language === "ko") {
    return [
      messages.runFailed,
      `무슨 일이 있었는지: ${friendlyErrorHint(message, language)}`,
      "사용자가 할 수 있는 행동: `/codex status`, `/codex stop`, `/codex logs`를 확인하세요.",
      "```",
      clipped,
      "```"
    ].join("\n");
  }
  return [
    messages.runFailed,
    `What happened: ${friendlyErrorHint(message, language)}`,
    "What you can do: check `/codex status`, `/codex stop`, or `/codex logs`.",
    "```",
    clipped,
    "```"
  ].join("\n");
}

export function summarizeLongResponse(content: string, language: BotLanguage = "en"): string {
  const normalized = content.trim();
  const limit = 1200;
  const summary = normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}...` : normalized;
  return language === "ko"
    ? `**Codex 응답이 길어서 Markdown 파일로 첨부합니다.**\n\n${summary}`
    : `**Codex response is long, so it is attached as a Markdown file.**\n\n${summary}`;
}

function hasStructuredHeadings(content: string): boolean {
  return /\*\*(Summary|요약|변경|검증|다음|Test|Tests|Changes|Next)/i.test(content);
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function plainTitle(value: string): string {
  return value.replace(/^\*\*/, "").replace(/\*\*$/, "");
}

function escapeMarkdown(value: string): string {
  return value.replace(/([*_`~|])/g, "\\$1");
}

function phaseLabel(value: string, language: BotLanguage): string {
  const phases = t(language).phases as Record<string, string>;
  return phases[value] ?? value;
}

function friendlyErrorHint(message: string, language: BotLanguage): string {
  const lower = message.toLowerCase();
  const messages = t(language);
  if (lower.includes("auth") || lower.includes("login")) {
    return messages.errorHintAuth;
  }
  if (lower.includes("permission") || lower.includes("eacces")) {
    return messages.errorHintPermission;
  }
  if (lower.includes("model")) {
    return messages.errorHintModel;
  }
  if (lower.includes("missing required environment variable")) {
    return messages.errorHintEnv;
  }
  if (lower.includes("stopped by user request")) {
    return messages.errorHintStopped;
  }
  return messages.errorHintDefault;
}
