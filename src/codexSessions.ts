import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestampMs: number;
}

export async function findLatestCodexSessionIdForWorkspace(
  workspaceDir: string,
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
): Promise<string | undefined> {
  const sessionsDir = path.join(codexHome, "sessions");
  const targetDir = path.resolve(workspaceDir);
  let latest: CodexSessionMeta | undefined;

  for await (const filePath of walkJsonlFiles(sessionsDir)) {
    const meta = await readSessionMeta(filePath);
    if (!meta || path.resolve(meta.cwd) !== targetDir) {
      continue;
    }

    if (!latest || meta.timestampMs > latest.timestampMs) {
      latest = meta;
    }
  }

  return latest?.id;
}

export async function findCodexSessionLogPath(
  sessionId: string,
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
): Promise<string | undefined> {
  const sessionsDir = path.join(codexHome, "sessions");

  for await (const filePath of walkJsonlFiles(sessionsDir)) {
    const meta = await readSessionMeta(filePath);
    if (meta?.id === sessionId) {
      return filePath;
    }
  }

  return undefined;
}

async function* walkJsonlFiles(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield entryPath;
    }
  }
}

async function readSessionMeta(filePath: string): Promise<CodexSessionMeta | undefined> {
  const raw = await readFile(filePath, "utf8");
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return undefined;
  }

  let event: unknown;
  try {
    event = JSON.parse(firstLine);
  } catch {
    return undefined;
  }

  if (!isRecord(event) || event.type !== "session_meta" || !isRecord(event.payload)) {
    return undefined;
  }

  const id = event.payload.id;
  const cwd = event.payload.cwd;
  if (typeof id !== "string" || id.length === 0 || typeof cwd !== "string" || cwd.length === 0) {
    return undefined;
  }

  const timestamp = typeof event.payload.timestamp === "string"
    ? Date.parse(event.payload.timestamp)
    : NaN;
  const timestampMs = Number.isFinite(timestamp)
    ? timestamp
    : (await stat(filePath)).mtimeMs;

  return { id, cwd, timestampMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
