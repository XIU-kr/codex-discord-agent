import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexRunOptions {
  codexBin: string;
  model: string;
  reasoningEffort: string;
  prompt: string;
  workspaceDir: string;
  sessionId?: string;
  imagePaths?: string[];
  signal?: AbortSignal;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}

export interface CodexRunResult {
  content: string;
  sessionId?: string;
}

export interface CodexParseState {
  sessionId?: string;
  finalMessages: string[];
  deltaMessages: string[];
}

export async function runCodex(options: CodexRunOptions): Promise<CodexRunResult> {
  const args = buildCodexArgs(options);
  const child = spawn(options.codexBin, args, {
    cwd: options.workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });
  options.onSpawn?.(child);

  let aborted = false;
  const abortHandler = (): void => {
    aborted = true;
    child.kill("SIGINT");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  };

  if (options.signal?.aborted) {
    abortHandler();
  } else {
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  }

  child.stdin.write(options.prompt);
  child.stdin.end();

  const parseState: CodexParseState = {
    finalMessages: [],
    deltaMessages: []
  };

  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      parseCodexJsonLine(line, parseState);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    options.signal?.removeEventListener("abort", abortHandler);
  });

  if (stdoutBuffer.trim().length > 0) {
    parseCodexJsonLine(stdoutBuffer, parseState);
  }

  if (exitCode !== 0) {
    if (aborted) {
      throw new Error("Codex run was stopped by user request.");
    }
    const message = stderr.trim() || `Codex exited with code ${exitCode ?? "unknown"}.`;
    throw new Error(message);
  }

  const content =
    parseState.finalMessages.join("\n\n").trim() || parseState.deltaMessages.join("").trim();

  return {
    content,
    sessionId: parseState.sessionId
  };
}

export function buildCodexArgs(options: CodexRunOptions): string[] {
  const commonArgs = [
    "--json",
    "-m",
    options.model,
    "-c",
    `model_reasoning_effort="${options.reasoningEffort}"`
  ];

  if (options.sessionId) {
    return ["exec", "resume", ...commonArgs, ...buildImageArgs(options.imagePaths), options.sessionId, "-"];
  }

  return [
    "exec",
    ...commonArgs,
    ...buildImageArgs(options.imagePaths),
    "--skip-git-repo-check",
    "-s",
    "danger-full-access",
    "-a",
    "never",
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

function buildType(value: unknown): string {
  return typeof value === "object" && value !== null && "type" in value
    ? String((value as { type?: unknown }).type ?? "")
    : "";
}

function extractSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  const type = buildType(value).toLowerCase();
  if (type.includes("session")) {
    const id = value.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
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
