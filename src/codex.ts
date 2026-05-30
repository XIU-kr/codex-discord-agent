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
  onResponseSnapshot?: (content: string) => void;
  onTranscriptSnapshot?: (content: string) => void;
  onInteractiveTurn?: (ids: { threadId: string; turnId: string }) => void;
  onMessage?: (content: string) => void | Promise<void>;
}

export type CodexUserInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string; detail?: "auto" | "low" | "high" };

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
  toolCalls?: Record<string, CodexToolCall>;
  toolOutputCallIds?: string[];
  toolTranscript?: string[];
  finalMessageSignatures?: string[];
}

interface CodexToolCall {
  name: string;
  command: string;
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
  primaryResetAt?: string;
  secondaryResetAt?: string;
  primaryWindowMinutes?: number;
  secondaryWindowMinutes?: number;
}

export interface CodexUsage {
  total?: CodexTokenUsage;
  last?: CodexTokenUsage;
  modelContextWindow?: number;
  rateLimits?: CodexRateLimitUsage;
}

type JsonRpcId = number;

interface JsonRpcSuccess {
  id: JsonRpcId;
  result?: unknown;
}

interface JsonRpcFailure {
  id: JsonRpcId;
  error?: { message?: string; code?: number; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface AppServerThreadResponse {
  thread?: {
    id?: string;
    sessionId?: string;
  };
}

interface AppServerTurnResponse {
  turn?: {
    id?: string;
  };
}

interface AppServerRunState {
  threadId?: string;
  turnId?: string;
  responseText: string;
  completed: boolean;
  error?: string;
  usage?: CodexUsage;
  transcriptEntries: string[];
  pendingMessageHandlers: Promise<void>[];
  notifiedAgentItemIds: Set<string>;
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private initialized?: Promise<void>;
  private stdoutBuffer = "";
  private stderr = "";
  private pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private listeners = new Set<(message: JsonRpcNotification) => void>();

  constructor(private readonly codexBin: string) {}

  async runTurn(options: CodexRunOptions): Promise<CodexRunResult> {
    await this.ensureInitialized();
    const state: AppServerRunState = {
      responseText: "",
      completed: false,
      transcriptEntries: [],
      pendingMessageHandlers: [],
      notifiedAgentItemIds: new Set()
    };

    const removeListener = this.addNotificationListener((message) => {
      markActivity();
      this.handleTurnNotification(message, state, options);
    });

    let runTimeout: ReturnType<typeof setTimeout> | undefined;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    let terminationReason: "aborted" | "timeout" | "idle" | undefined;

    const interrupt = (): void => {
      terminationReason ??= options.signal?.aborted ? "aborted" : "timeout";
      if (state.threadId && state.turnId) {
        void this.request("turn/interrupt", {
          threadId: state.threadId,
          turnId: state.turnId
        }).catch(() => undefined);
      }
    };
    const refreshIdleTimeout = (): void => {
      if (!options.idleTimeoutMs) {
        return;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        terminationReason ??= "idle";
        interrupt();
      }, options.idleTimeoutMs);
      idleTimeout.unref();
    };
    const markActivity = (): void => {
      options.onActivity?.();
      refreshIdleTimeout();
    };
    const abortHandler = (): void => {
      terminationReason = "aborted";
      interrupt();
    };

    try {
      if (options.signal?.aborted) {
        abortHandler();
      } else {
        options.signal?.addEventListener("abort", abortHandler, { once: true });
      }
      if (options.runTimeoutMs) {
        runTimeout = setTimeout(() => {
          terminationReason = "timeout";
          interrupt();
        }, options.runTimeoutMs);
        runTimeout.unref();
      }
      refreshIdleTimeout();

      const thread = await this.openThread(options);
      state.threadId = thread.thread?.id ?? thread.thread?.sessionId ?? options.sessionId;
      if (!state.threadId) {
        throw new Error("Codex app server did not return a thread id.");
      }

      const turn = await this.request("turn/start", {
        threadId: state.threadId,
        input: buildAppServerInput(options),
        model: options.model,
        effort: options.reasoningEffort,
        cwd: options.workspaceDir,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" }
      }) as AppServerTurnResponse;
      state.turnId = turn.turn?.id;
      if (!state.turnId) {
        throw new Error("Codex app server did not return a turn id.");
      }
      options.onInteractiveTurn?.({ threadId: state.threadId, turnId: state.turnId });

      options.onEvent?.({ phase: "codex", summary: "Codex interactive turn started." });
      markActivity();

      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (state.completed) {
            clearInterval(check);
            resolve();
          }
          if (state.error) {
            clearInterval(check);
            reject(new Error(state.error));
          }
          if (terminationReason) {
            clearInterval(check);
            reject(new Error(terminationReason));
          }
        }, 200);
        check.unref();
      });

      if (terminationReason === "aborted") {
        throw new Error("Codex run was stopped by user request.");
      }
      if (terminationReason === "timeout") {
        throw new Error(`Codex run exceeded the ${formatSeconds(options.runTimeoutMs)} limit and was stopped.`);
      }
      if (terminationReason === "idle") {
        throw new Error(`Codex produced no output for ${formatSeconds(options.idleTimeoutMs)} and was stopped.`);
      }
      await Promise.all(state.pendingMessageHandlers);

      return {
        content: state.responseText.trim(),
        sessionId: state.threadId,
        usage: state.usage
      };
    } finally {
      removeListener();
      options.signal?.removeEventListener("abort", abortHandler);
      if (runTimeout) {
        clearTimeout(runTimeout);
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
    }
  }

  async steerTurn(threadId: string, turnId: string, input: CodexUserInputItem[]): Promise<void> {
    await this.ensureInitialized();
    await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input
    });
  }

  private async openThread(options: CodexRunOptions): Promise<AppServerThreadResponse> {
    const common = {
      model: options.model,
      cwd: options.workspaceDir,
      runtimeWorkspaceRoots: [options.workspaceDir],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        model_reasoning_effort: options.reasoningEffort
      }
    };
    if (options.sessionId) {
      try {
        return await this.request("thread/resume", {
          threadId: options.sessionId,
          ...common,
          excludeTurns: true
        }) as AppServerThreadResponse;
      } catch {
        // Fall through to a new app-server thread if the persisted id cannot be resumed.
      }
    }
    return await this.request("thread/start", common) as AppServerThreadResponse;
  }

  private handleTurnNotification(
    message: JsonRpcNotification,
    state: AppServerRunState,
    options: CodexRunOptions
  ): void {
    const params = asRecord(message.params);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    if (state.threadId && threadId && threadId !== state.threadId) {
      return;
    }
    if (state.turnId && turnId && turnId !== state.turnId) {
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const usage = usageFromAppServer(asRecord(params.tokenUsage));
      if (usage) {
        state.usage = usage;
        options.onUsage?.(usage);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (delta) {
        state.responseText += delta;
        options.onResponseSnapshot?.(state.responseText);
        options.onEvent?.({ phase: "responding", summary: "Codex is writing a response." });
      }
      return;
    }

    if (message.method === "item/commandExecution/outputDelta" || message.method === "item/fileChange/outputDelta") {
      const delta = stringValue(params.delta);
      if (delta) {
        state.transcriptEntries.push(delta.trim());
        options.onTranscriptSnapshot?.(latestNonEmptyEntries(state.transcriptEntries).join("\n\n"));
        options.onEvent?.({ phase: "tool", summary: "Codex tool output received." });
      }
      return;
    }

    if (message.method === "item/mcpToolCall/progress") {
      const progress = stringValue(params.message);
      if (progress) {
        state.transcriptEntries.push(progress);
        options.onTranscriptSnapshot?.(latestNonEmptyEntries(state.transcriptEntries).join("\n\n"));
        options.onEvent?.({ phase: "tool", summary: progress });
      }
      return;
    }

    if (message.method === "item/completed") {
      const item = asRecord(params.item);
      const itemType = stringValue(item.type);
      if (itemType === "agentMessage") {
        const text = stringValue(item.text);
        const itemId = stringValue(item.id);
        if (text && (!itemId || !state.notifiedAgentItemIds.has(itemId))) {
          if (itemId) {
            state.notifiedAgentItemIds.add(itemId);
          }
          state.responseText = text;
          options.onResponseSnapshot?.(state.responseText);
          const handler = options.onMessage;
          if (handler) {
            state.pendingMessageHandlers.push(withOptionalTimeout(
              Promise.resolve(handler(text)),
              options.messageHandlerTimeoutMs,
              "Discord message handler"
            ));
          }
        }
      } else if (itemType === "commandExecution") {
        const command = stringValue(item.command);
        const output = stringValue(item.aggregatedOutput);
        if (command || output) {
          state.transcriptEntries.push([command ? `• Running \`${command}\`` : undefined, output].filter(Boolean).join("\n"));
          options.onTranscriptSnapshot?.(latestNonEmptyEntries(state.transcriptEntries).join("\n\n"));
        }
      } else if (itemType === "mcpToolCall") {
        const server = stringValue(item.server);
        const tool = stringValue(item.tool);
        if (server || tool) {
          state.transcriptEntries.push(`• MCP tool: ${[server, tool].filter(Boolean).join("/")}`);
          options.onTranscriptSnapshot?.(latestNonEmptyEntries(state.transcriptEntries).join("\n\n"));
        }
      }
      return;
    }

    if (message.method === "turn/completed") {
      const turn = asRecord(params.turn);
      const status = stringValue(turn.status);
      if (status === "failed") {
        const error = asRecord(turn.error);
        state.error = stringValue(error.message) ?? "Codex turn failed.";
        state.completed = true;
        return;
      }
      state.completed = true;
      options.onEvent?.({ phase: "responding", summary: "Codex interactive turn completed." });
      return;
    }

    if (message.method === "error") {
      const error = asRecord(params.error);
      options.onEvent?.({ phase: "failed", summary: stringValue(error.message) ?? "Codex reported an error." });
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      this.start();
      await this.request("initialize", {
        clientInfo: {
          name: "codex-discord-agent",
          version: "0.0.34"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      });
      this.notify("initialized");
    })();
    await this.initialized;
  }

  private start(): void {
    if (this.child && !this.child.killed) {
      return;
    }
    this.child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("close", () => {
      const error = new Error(this.stderr.trim() || "Codex app server exited.");
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
      this.initialized = undefined;
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.start();
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, id, params });
    this.child?.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.start();
    const payload = params === undefined
      ? JSON.stringify({ jsonrpc: "2.0", method })
      : JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child?.stdin.write(`${payload}\n`);
  }

  private addNotificationListener(listener: (message: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const message = JSON.parse(trimmed) as JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
      if ("id" in message && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if ("error" in message && message.error) {
          pending?.reject(new Error(message.error.message ?? `Codex app server request ${message.id} failed.`));
        } else {
          pending?.resolve((message as JsonRpcSuccess).result);
        }
      } else if ("method" in message) {
        for (const listener of this.listeners) {
          listener(message);
        }
      }
    }
  }
}

const appServerClients = new Map<string, CodexAppServerClient>();

export async function runCodexInteractive(options: CodexRunOptions): Promise<CodexRunResult> {
  let client = appServerClients.get(options.codexBin);
  if (!client) {
    client = new CodexAppServerClient(options.codexBin);
    appServerClients.set(options.codexBin, client);
  }
  return client.runTurn(options);
}

export async function steerCodexInteractive(options: {
  codexBin: string;
  threadId: string;
  turnId: string;
  prompt: string;
}): Promise<void> {
  let client = appServerClients.get(options.codexBin);
  if (!client) {
    client = new CodexAppServerClient(options.codexBin);
    appServerClients.set(options.codexBin, client);
  }
  await client.steerTurn(options.threadId, options.turnId, [{
    type: "text",
    text: options.prompt,
    text_elements: []
  }]);
}

function buildAppServerInput(options: CodexRunOptions): CodexUserInputItem[] {
  const input: CodexUserInputItem[] = [{
    type: "text",
    text: options.prompt,
    text_elements: []
  }];
  for (const imagePath of options.imagePaths ?? []) {
    input.push({
      type: "localImage",
      path: imagePath,
      detail: "auto"
    });
  }
  return input;
}

function latestNonEmptyEntries(entries: string[], count = 6): string[] {
  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(-count);
}

function usageFromAppServer(value: Record<string, unknown>): CodexUsage | undefined {
  const total = parseAppServerTokenUsage(value.total);
  const last = parseAppServerTokenUsage(value.last);
  const usage: CodexUsage = {};
  if (total) {
    usage.total = total;
  }
  if (last) {
    usage.last = last;
  }
  const modelContextWindow = numberValue(value.modelContextWindow);
  if (typeof modelContextWindow === "number") {
    usage.modelContextWindow = modelContextWindow;
  }
  return usage.total || usage.last || usage.modelContextWindow ? usage : undefined;
}

function parseAppServerTokenUsage(value: unknown): CodexTokenUsage | undefined {
  const record = asRecord(value);
  const usage: CodexTokenUsage = {
    inputTokens: numberValue(record.inputTokens),
    cachedInputTokens: numberValue(record.cachedInputTokens),
    outputTokens: numberValue(record.outputTokens),
    reasoningOutputTokens: numberValue(record.reasoningOutputTokens),
    totalTokens: numberValue(record.totalTokens)
  };
  return Object.values(usage).some((part) => typeof part === "number") ? usage : undefined;
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
    deltaMessages: [],
    toolCalls: {},
    toolOutputCallIds: [],
    toolTranscript: []
  };
  const pendingMessageHandlers: Promise<void>[] = [];
  const notifiedMessages = new Set<string>();
  let stopSessionLogWatch: (() => void) | undefined;
  const sessionLogWatcher = options.sessionId && (options.onMessage || options.onResponseSnapshot || options.onTranscriptSnapshot)
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
    const previousDeltaCount = parseState.deltaMessages.length;
    const previousTranscriptCount = parseState.toolTranscript?.length ?? 0;
    const previousUsageSignature = usageSignature(parseState.usage);
    parseCodexJsonLine(line, parseState);
    if ((parseState.toolTranscript?.length ?? 0) > previousTranscriptCount) {
      options.onTranscriptSnapshot?.(parseState.toolTranscript?.join("\n\n").trim() ?? "");
    }
    if (parseState.finalMessages.length > previousMessageCount || parseState.deltaMessages.length > previousDeltaCount) {
      const snapshot = parseState.finalMessages.join("\n\n").trim() || parseState.deltaMessages.join("").trim();
      if (snapshot) {
        options.onResponseSnapshot?.(snapshot);
      }
    }
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
          "Timed out while sending the response to Discord."
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
      const append = await readSessionLogAppend(filePath, offset);
      if (!append.text) {
        continue;
      }

      buffer += append.text;
      offset = append.offset;

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

export async function readSessionLogAppend(
  filePath: string,
  offset: number
): Promise<{ text: string; offset: number }> {
  const raw = await readFile(filePath).catch(() => Buffer.alloc(0));
  if (raw.byteLength <= offset) {
    return { text: "", offset };
  }
  return {
    text: raw.subarray(offset).toString("utf8"),
    offset: raw.byteLength
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
  const type = buildType(event).toLowerCase();
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const payloadTool = payload && typeof payload.name === "string"
    ? describeToolCall(payload.name, payload.arguments)
    : undefined;
  const candidates = [
    event.command,
    event.name,
    event.tool,
    payload?.command,
    payloadTool,
    payload?.name
  ];
  const value = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  if (value) {
    const command = value.length > 140 ? `${value.slice(0, 137)}...` : value;
    if (/\b(test|bun test|npm test|pytest|cargo test|go test)\b/i.test(command)) {
      return `Running tests: ${command}`;
    }
    if (/\b(apply_patch|write|edit|patch)\b/i.test(type) || /\b(apply_patch)\b/i.test(command)) {
      return `Editing code: ${command}`;
    }
    if (/\b(rg|grep|sed|cat|ls|find)\b/i.test(command)) {
      return `Reading files: ${command}`;
    }
    return `Running command: ${command}`;
  }
  if (/\b(write|edit|patch)\b/i.test(type)) {
    return "Editing code.";
  }
  return "Using a tool.";
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

  collectToolTranscript(event, state);

  const finalMessage = extractFinalAssistantMessage(event);
  if (finalMessage) {
    appendFinalMessage(state, finalMessage);
    return;
  }

  const deltaMessage = extractAssistantDelta(event);
  if (deltaMessage) {
    state.deltaMessages.push(deltaMessage);
  }
}

function appendFinalMessage(state: CodexParseState, message: string): void {
  const signature = message.trim();
  if (!signature) {
    return;
  }
  state.finalMessageSignatures ??= state.finalMessages.map((existing) => existing.trim());
  if (state.finalMessageSignatures.includes(signature)) {
    return;
  }
  state.finalMessages.push(message);
  state.finalMessageSignatures.push(signature);
}

function collectToolTranscript(event: unknown, state: CodexParseState): void {
  if (!isRecord(event)) {
    return;
  }

  const payload = isRecord(event.payload) ? event.payload : undefined;
  const record = payload ?? event;
  const type = buildType(record).toLowerCase();
  const callId = stringValue(record.call_id);

  if (type === "function_call" || type === "custom_tool_call") {
    const name = stringValue(record.name) ?? "tool";
    if (!callId) {
      return;
    }
    const command = describeToolCall(name, record.arguments);
    state.toolCalls ??= {};
    state.toolCalls[callId] = { name, command };
    appendToolTranscript(state, `• Running \`${inlineTranscript(command)}\``);
    return;
  }

  if (!callId && (type.includes("exec") || type.includes("command")) && typeof record.command === "string") {
    appendToolTranscript(state, `• Running \`${inlineTranscript(record.command)}\``);
    return;
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    if (!callId || hasToolOutput(state, callId)) {
      return;
    }
    const toolCall = state.toolCalls?.[callId];
    const output = stringValue(record.output) ?? "";
    appendToolOutput(state, callId, toolCall?.command ?? toolCall?.name ?? "tool", output);
    return;
  }

  if (type.endsWith("_end") || type.includes("patch_apply_end")) {
    if (!callId || hasToolOutput(state, callId)) {
      return;
    }
    const toolCall = state.toolCalls?.[callId];
    const stdout = stringValue(record.stdout) ?? "";
    const stderr = stringValue(record.stderr) ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    appendToolOutput(state, callId, toolCall?.command ?? toolCall?.name ?? type, output);
  }
}

function describeToolCall(name: string, rawArguments: unknown): string {
  const args = parseToolArguments(rawArguments);
  if (name === "exec_command" && isRecord(args) && typeof args.cmd === "string") {
    return args.cmd;
  }
  if (name === "apply_patch") {
    return "apply_patch";
  }
  if (name === "update_plan") {
    return "update_plan";
  }
  if (name === "update_goal") {
    return "update_goal";
  }
  return name;
}

function parseToolArguments(rawArguments: unknown): unknown {
  if (typeof rawArguments !== "string") {
    return rawArguments;
  }
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

function appendToolOutput(state: CodexParseState, callId: string, command: string, output: string): void {
  state.toolOutputCallIds ??= [];
  state.toolOutputCallIds.push(callId);
  const normalizedOutput = summarizeToolOutput(output);
  appendToolTranscript(state, [`• Ran \`${inlineTranscript(command)}\``, `  └ ${normalizedOutput}`].join("\n"));
}

function appendToolTranscript(state: CodexParseState, entry: string): void {
  state.toolTranscript ??= [];
  state.toolTranscript.push(entry);
  if (state.toolTranscript.length > 30) {
    state.toolTranscript.splice(0, state.toolTranscript.length - 30);
  }
}

function hasToolOutput(state: CodexParseState, callId: string): boolean {
  return state.toolOutputCallIds?.includes(callId) ?? false;
}

function summarizeToolOutput(output: string): string {
  const normalized = output.trim();
  if (!normalized) {
    return "(no output)";
  }
  const cleaned = normalized
    .replace(/^Chunk ID: .*\n/m, "")
    .replace(/^Wall time: .*\n/m, "")
    .replace(/^Process exited with code \d+\n/m, "")
    .replace(/^Original token count: .*\n/m, "")
    .replace(/^Output:\n/m, "")
    .replace(/^Output:$/m, "")
    .trim();
  if (!cleaned) {
    return "(no output)";
  }
  return cleaned.length > 900 ? `${cleaned.slice(0, 897).trimEnd()}...` : cleaned;
}

function inlineTranscript(value: string): string {
  return value.replace(/`/g, "'");
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
        primaryResetAt: parseRateLimitReset(rateLimits.primary),
        secondaryResetAt: parseRateLimitReset(rateLimits.secondary),
        primaryWindowMinutes: parseRateLimitWindowMinutes(rateLimits.primary),
        secondaryWindowMinutes: parseRateLimitWindowMinutes(rateLimits.secondary),
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

function parseRateLimitReset(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["reset_at", "resets_at", "resetAt", "resetsAt", "next_reset_at", "nextResetAt"]) {
    const candidate = stringValue(value[key]);
    if (candidate) {
      return candidate;
    }
  }
  for (const key of ["reset_seconds", "resets_in_seconds", "reset_after_seconds"]) {
    const seconds = numberValue(value[key]);
    if (seconds !== undefined) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }
  return undefined;
}

function parseRateLimitWindowMinutes(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["window_minutes", "windowMinutes"]) {
    const minutes = numberValue(value[key]);
    if (minutes !== undefined) {
      return minutes;
    }
  }
  for (const key of ["window_seconds", "windowSeconds"]) {
    const seconds = numberValue(value[key]);
    if (seconds !== undefined) {
      return Math.round(seconds / 60);
    }
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
