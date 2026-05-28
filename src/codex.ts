import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { findCodexSessionLogPath } from "./codexSessions";

export interface CodexRunOptions {
  codexBin: string;
  model: string;
  reasoningEffort: string;
  prompt: string;
  workspaceDir: string;
  sessionId?: string;
  sessionLogPath?: string;
  imagePaths?: string[];
  signal?: AbortSignal;
  runTimeoutMs?: number;
  idleTimeoutMs?: number;
  messageHandlerTimeoutMs?: number;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  onActivity?: () => void;
  onEvent?: (event: CodexRunEvent) => void;
  onUsage?: (usage: CodexUsage) => void;
  onMessage?: (content: string) => void | Promise<void>;
}

export interface CodexRunResult {
  content: string;
  sessionId?: string;
  sessionLogPath?: string;
  usage?: CodexUsage;
}

export interface CodexRunEvent {
  phase: "codex" | "tool" | "responding" | "failed";
  summary: string;
}

export interface CodexParseState {
  sessionId?: string;
  finalMessages: string[];
  deltaMessages: string[];
  usage?: CodexUsage;
}

export interface CodexTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface CodexRateLimitUsage {
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  planType?: string;
  rateLimitReachedType?: string;
}

export interface CodexUsage {
  total?: CodexTokenUsage;
  last?: CodexTokenUsage;
  modelContextWindow?: number;
  rateLimits?: CodexRateLimitUsage;
}

export async function runCodex(options: CodexRunOptions): Promise<CodexRunResult> {
  const args = buildCodexArgs(options);
  const child = spawn(options.codexBin, args, {
    cwd: options.workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });
  options.onSpawn?.(child);

  let terminationReason: "aborted" | "timeout" | "idle" | undefined;
  let closed = false;
  let runTimeout: ReturnType<typeof setTimeout> | undefined;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;

  const terminate = (reason: "aborted" | "timeout" | "idle"): void => {
    terminationReason ??= reason;
    child.kill("SIGINT");
    setTimeout(() => {
      if (!closed) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  };
  const abortHandler = (): void => terminate("aborted");
  const markActivity = (): void => {
    options.onActivity?.();
    refreshIdleTimeout();
  };
  const refreshIdleTimeout = (): void => {
    if (!options.idleTimeoutMs) {
      return;
    }
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => {
      terminate("idle");
    }, options.idleTimeoutMs);
    idleTimeout.unref();
  };

  if (options.signal?.aborted) {
    abortHandler();
  } else {
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  }
  if (options.runTimeoutMs) {
    runTimeout = setTimeout(() => {
      terminate("timeout");
    }, options.runTimeoutMs);
    runTimeout.unref();
  }
  refreshIdleTimeout();

  child.stdin.write(options.prompt);
  child.stdin.end();

  const parseState: CodexParseState = {
    finalMessages: [],
    deltaMessages: []
  };
  const pendingMessageHandlers: Promise<void>[] = [];
  const notifiedMessages = new Set<string>();
  let stopSessionLogWatch: (() => void) | undefined;
  const sessionLogWatcher = options.sessionId && options.onMessage
    ? watchSessionLog(options.sessionId, parseCodexJsonLineAndNotify, options.sessionLogPath)
    : undefined;
  stopSessionLogWatch = sessionLogWatcher?.stop;

  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    markActivity();
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      parseCodexJsonLineAndNotify(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    markActivity();
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      resolve(code);
    });
  }).finally(() => {
    options.signal?.removeEventListener("abort", abortHandler);
    if (runTimeout) {
      clearTimeout(runTimeout);
    }
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    stopSessionLogWatch?.();
  });

  if (stdoutBuffer.trim().length > 0) {
    parseCodexJsonLineAndNotify(stdoutBuffer);
  }

  await sessionLogWatcher?.done;
  await Promise.all(pendingMessageHandlers);

  if (terminationReason === "aborted") {
    throw new Error("Codex run was stopped by user request.");
  }
  if (terminationReason === "timeout") {
    throw new Error(`Codex run exceeded the ${formatSeconds(options.runTimeoutMs)} limit and was stopped.`);
  }
  if (terminationReason === "idle") {
    throw new Error(`Codex produced no output for ${formatSeconds(options.idleTimeoutMs)} and was stopped.`);
  }

  if (exitCode !== 0) {
    const message = stderr.trim() || `Codex exited with code ${exitCode ?? "unknown"}.`;
    throw new Error(message);
  }

  const content =
    parseState.finalMessages.join("\n\n").trim() || parseState.deltaMessages.join("").trim();

  return {
    content,
    sessionId: parseState.sessionId,
    sessionLogPath: parseState.sessionId
      ? await findCodexSessionLogPath(parseState.sessionId).catch(() => undefined)
      : undefined,
    usage: parseState.usage
  };

  function parseCodexJsonLineAndNotify(line: string): void {
    markActivity();
    const previousMessageCount = parseState.finalMessages.length;
    const previousUsageSignature = usageSignature(parseState.usage);
    parseCodexJsonLine(line, parseState);
    if (usageSignature(parseState.usage) !== previousUsageSignature && parseState.usage) {
      options.onUsage?.(parseState.usage);
    }
    const eventSummary = summarizeCodexJsonLine(line, parseState.finalMessages.length > previousMessageCount);
    if (eventSummary) {
      options.onEvent?.(eventSummary);
    }

    for (const message of parseState.finalMessages.slice(previousMessageCount)) {
      if (notifiedMessages.has(message)) {
        continue;
      }
      notifiedMessages.add(message);
      const handlerResult = options.onMessage?.(message);
      if (handlerResult) {
        pendingMessageHandlers.push(withOptionalTimeout(
          Promise.resolve(handlerResult),
          options.messageHandlerTimeoutMs,
          "Timed out while sending a Codex response to Discord."
        ));
      }
    }
  }
}

function watchSessionLog(
  sessionId: string,
  onLine: (line: string) => void,
  knownPath?: string
): { stop: () => void; done: Promise<void> } {
  let stopped = false;
  let offset = 0;
  let buffer = "";

  const done = (async () => {
    const knownPathExists = knownPath
      ? await stat(knownPath).then(() => true).catch(() => false)
      : false;
    const filePath = knownPathExists
      ? knownPath
      : await waitForSessionLogPath(sessionId);
    if (!filePath) {
      return;
    }

    offset = (await stat(filePath)).size;

    while (!stopped) {
      await sleep(1_000);
      const raw = await readFile(filePath, "utf8").catch(() => "");
      if (raw.length <= offset) {
        continue;
      }

      buffer += raw.slice(offset);
      offset = raw.length;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    }

    if (buffer.trim()) {
      onLine(buffer);
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
    done
  };
}

async function waitForSessionLogPath(sessionId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const filePath = await findCodexSessionLogPath(sessionId);
    if (filePath) {
      return filePath;
    }
    await sleep(500);
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withOptionalTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (!timeoutMs) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function formatSeconds(ms: number | undefined): string {
  if (!ms) {
    return "configured";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function summarizeCodexJsonLine(line: string, producedMessage: boolean): CodexRunEvent | undefined {
  if (producedMessage) {
    return { phase: "responding", summary: "Assistant response received." };
  }

  let event: unknown;
  try {
    event = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(event)) {
    return undefined;
  }

  const type = buildType(event).toLowerCase();
  const nestedType = isRecord(event.payload) ? buildType(event.payload).toLowerCase() : "";
  const combinedType = `${type} ${nestedType}`;
  if (combinedType.includes("error") || combinedType.includes("failed")) {
    return { phase: "failed", summary: "Codex reported an error." };
  }
  if (
    combinedType.includes("tool") ||
    combinedType.includes("exec") ||
    combinedType.includes("command") ||
    combinedType.includes("mcp") ||
    combinedType.includes("function")
  ) {
    return { phase: "tool", summary: summarizeToolEvent(event) };
  }
  if (combinedType.includes("message") || combinedType.includes("agent")) {
    return { phase: "responding", summary: "Codex is preparing a response." };
  }
  if (combinedType.includes("session")) {
    return { phase: "codex", summary: "Codex session is active." };
  }

  return { phase: "codex", summary: type || "Codex event received." };
}

function summarizeToolEvent(event: Record<string, unknown>): string {
  const candidates = [
    event.command,
    event.name,
    event.tool,
    isRecord(event.payload) ? event.payload.command : undefined,
    isRecord(event.payload) ? event.payload.name : undefined
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return value ? `Tool activity: ${value}` : "Codex is using a tool.";
}

export function buildCodexArgs(options: CodexRunOptions): string[] {
  const commonArgs = [
    "--json",
    "-m",
    options.model,
    "-c",
    `model_reasoning_effort="${options.reasoningEffort}"`,
    "--dangerously-bypass-approvals-and-sandbox"
  ];

  if (options.sessionId) {
    return ["exec", "resume", ...commonArgs, ...buildImageArgs(options.imagePaths), options.sessionId, "-"];
  }

  return [
    "exec",
    ...commonArgs,
    ...buildImageArgs(options.imagePaths),
    "--skip-git-repo-check",
    "-C",
    options.workspaceDir,
    "-"
  ];
}

function buildImageArgs(imagePaths: string[] | undefined): string[] {
  return (imagePaths ?? []).flatMap((imagePath) => ["-i", imagePath]);
}

export function parseCodexJsonLine(line: string, state: CodexParseState): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }

  const sessionId = extractSessionId(event);
  if (sessionId) {
    state.sessionId = sessionId;
  }

  const usage = extractCodexUsage(event);
  if (usage) {
    state.usage = usage;
  }

  const finalMessage = extractFinalAssistantMessage(event);
  if (finalMessage) {
    state.finalMessages.push(finalMessage);
    return;
  }

  const deltaMessage = extractAssistantDelta(event);
  if (deltaMessage) {
    state.deltaMessages.push(deltaMessage);
  }
}

function extractCodexUsage(value: unknown): CodexUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (buildType(value).toLowerCase() === "token_count" && isRecord(value.info)) {
    return usageFromTokenCount(value);
  }

  if (isRecord(value.payload)) {
    const nested = extractCodexUsage(value.payload);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function usageFromTokenCount(value: Record<string, unknown>): CodexUsage | undefined {
  const info = isRecord(value.info) ? value.info : undefined;
  if (!info) {
    return undefined;
  }

  const rateLimits = isRecord(value.rate_limits) ? value.rate_limits : undefined;
  return {
    total: parseTokenUsage(info.total_token_usage),
    last: parseTokenUsage(info.last_token_usage),
    modelContextWindow: numberValue(info.model_context_window),
    rateLimits: rateLimits
      ? {
        primaryUsedPercent: parseRateLimitPercent(rateLimits.primary),
        secondaryUsedPercent: parseRateLimitPercent(rateLimits.secondary),
        planType: stringValue(rateLimits.plan_type),
        rateLimitReachedType: stringValue(rateLimits.rate_limit_reached_type)
      }
      : undefined
  };
}

function parseTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    inputTokens: numberValue(value.input_tokens),
    cachedInputTokens: numberValue(value.cached_input_tokens),
    outputTokens: numberValue(value.output_tokens),
    reasoningOutputTokens: numberValue(value.reasoning_output_tokens),
    totalTokens: numberValue(value.total_tokens)
  };
}

function parseRateLimitPercent(value: unknown): number | undefined {
  return isRecord(value) ? numberValue(value.used_percent) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function usageSignature(usage: CodexUsage | undefined): string {
  return usage ? JSON.stringify(usage) : "";
}

function buildType(value: unknown): string {
  return typeof value === "object" && value !== null && "type" in value
    ? String((value as { type?: unknown }).type ?? "")
    : "";
}

function extractSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = buildType(value).toLowerCase();

  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  if (type.includes("session")) {
    const id = value.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }

    const payload = value.payload;
    if (isRecord(payload)) {
      for (const key of ["session_id", "sessionId", "id"]) {
        const candidate = payload[key];
        if (typeof candidate === "string" && candidate.length > 0) {
          return candidate;
        }
      }
    }
  }

  for (const nested of Object.values(value)) {
    const candidate = extractSessionId(nested);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function extractFinalAssistantMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const direct = extractAssistantMessageRecord(value);
  if (direct) {
    return direct;
  }

  const item = value.item;
  if (item) {
    const nested = extractAssistantMessageRecord(item);
    if (nested) {
      return nested;
    }
  }

  const payload = value.payload;
  if (payload) {
    const nested = extractFinalAssistantMessage(payload);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function extractAssistantMessageRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = buildType(value).toLowerCase();
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  const looksAssistant =
    role === "assistant" ||
    type === "message" ||
    type === "agent_message" ||
    type === "assistant_message" ||
    type.endsWith(".agent_message") ||
    type.endsWith(".assistant_message");

  if (!looksAssistant) {
    return undefined;
  }

  for (const key of ["message", "text", "content"]) {
    const text = extractText(value[key]);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function extractAssistantDelta(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = buildType(value).toLowerCase();
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  const isDelta = type.includes("delta");
  const isAssistant = role === "assistant" || type.includes("assistant") || type.includes("agent");

  if (!isDelta || !isAssistant) {
    return undefined;
  }

  return extractText(value.delta) ?? extractText(value.text) ?? extractText(value.content);
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value.map(extractText).filter(Boolean).join("");
    return text.length > 0 ? text : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["text", "value", "message", "content", "output_text"]) {
    const text = extractText(value[key]);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
