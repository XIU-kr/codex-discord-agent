import { t, type BotLanguage } from "./i18n";

export const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_CHUNK_LIMIT = 1900;
const FILE_RESPONSE_THRESHOLD = 8_000;

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
  return `${t(language).runFailed}\n${friendlyErrorHint(message, language)}\n\`\`\`\n${clipped}\n\`\`\``;
}

function hasStructuredHeadings(content: string): boolean {
  return /\*\*(Summary|요약|변경|검증|다음|Test|Tests|Changes|Next)/i.test(content);
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
