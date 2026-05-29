import { spawn } from "node:child_process";

export interface ShellCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (snapshot: ShellCommandSnapshot) => void;
}

export interface ShellCommandSnapshot {
  command: string;
  cwd: string;
  durationMs: number;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ShellCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
  truncated: boolean;
  blockedReason?: string;
}

const dangerousPatterns: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(?:-[^\s]*[rf][^\s]*\s+){1,}(?:--\s+)?\/(?:\s|$|\*)/i,
    reason: "Refusing to recursively remove the filesystem root."
  },
  {
    pattern: /\brm\s+(?:-[^\s]*[rf][^\s]*\s+){1,}(?:--\s+)?\/\*/i,
    reason: "Refusing to recursively remove root contents."
  },
  {
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i,
    reason: "Refusing to format a filesystem."
  },
  {
    pattern: /\bdd\b[\s\S]*\bof=\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|mapper\/)/i,
    reason: "Refusing to write raw data directly to a block device."
  },
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Refusing to run a fork bomb."
  },
  {
    pattern: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i,
    reason: "Refusing to make the filesystem root world-writable."
  },
  {
    pattern: /\bchown\s+-R\s+\S+\s+\/(?:\s|$)/i,
    reason: "Refusing to recursively change ownership of the filesystem root."
  },
  {
    pattern: /\bshred\b[\s\S]*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|mapper\/)/i,
    reason: "Refusing to shred a block device."
  }
];

export function validateShellCommand(command: string): string | undefined {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No command was provided.";
  }

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(normalized)) {
      return reason;
    }
  }

  return undefined;
}

export async function runShellCommand(command: string, options: ShellCommandOptions): Promise<ShellCommandResult> {
  const startedAt = Date.now();
  const blockedReason = validateShellCommand(command);
  if (blockedReason) {
    return {
      command,
      cwd: options.cwd,
      exitCode: null,
      signal: null,
      durationMs: 0,
      output: "",
      timedOut: false,
      truncated: false,
      blockedReason
    };
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timeout.unref();

    const appendOutput = (chunk: string): void => {
      if (outputBytes >= options.maxOutputBytes) {
        truncated = true;
        emitOutput();
        return;
      }
      const buffer = Buffer.from(chunk, "utf8");
      const available = options.maxOutputBytes - outputBytes;
      if (buffer.byteLength > available) {
        output += buffer.subarray(0, available).toString("utf8");
        outputBytes = options.maxOutputBytes;
        truncated = true;
        emitOutput();
        return;
      }
      output += chunk;
      outputBytes += buffer.byteLength;
      emitOutput();
    };

    const emitOutput = (): void => {
      options.onOutput?.({
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        output: output.trimEnd(),
        timedOut,
        truncated
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        cwd: options.cwd,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        output: error.message,
        timedOut,
        truncated,
        blockedReason: undefined
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        command,
        cwd: options.cwd,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        output: output.trimEnd(),
        timedOut,
        truncated,
        blockedReason: undefined
      });
    });
  });
}
