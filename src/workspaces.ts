import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ThreadWorkspace {
  dir: string;
  sessionFile: string;
  stateDir: string;
  attachmentsDir: string;
}

interface SessionState {
  sessionId?: string;
  updatedAt: string;
}

const stateDirName = ".codex-discord-agent";
const sessionFileName = "session.json";
const attachmentsDirName = "attachments";

export async function ensureThreadWorkspace(
  baseDir: string,
  guildId: string,
  threadId: string
): Promise<ThreadWorkspace> {
  const dir = path.join(baseDir, guildId, threadId);
  const stateDir = path.join(dir, stateDirName);
  const attachmentsDir = path.join(dir, attachmentsDirName);
  await mkdir(stateDir, { recursive: true });
  await mkdir(attachmentsDir, { recursive: true });

  return {
    dir,
    sessionFile: path.join(stateDir, sessionFileName),
    stateDir,
    attachmentsDir
  };
}

export async function loadSessionId(workspace: ThreadWorkspace): Promise<string | undefined> {
  try {
    const raw = await readFile(workspace.sessionFile, "utf8");
    const state = JSON.parse(raw) as SessionState;
    return typeof state.sessionId === "string" && state.sessionId.length > 0
      ? state.sessionId
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveSessionId(workspace: ThreadWorkspace, sessionId: string): Promise<void> {
  const state: SessionState = {
    sessionId,
    updatedAt: new Date().toISOString()
  };
  await writeFile(workspace.sessionFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function resetSession(workspace: ThreadWorkspace): Promise<void> {
  await rm(workspace.sessionFile, { force: true });
}

export async function getWorkspaceStats(workspace: ThreadWorkspace): Promise<{
  files: number;
  bytes: number;
  updatedAt?: Date;
}> {
  return walkStats(workspace.dir);
}

export async function cleanStaleWorkspaces(
  baseDir: string,
  guildId: string,
  staleDays: number,
  skipThreadId?: string
): Promise<{ removed: number; skipped: number }> {
  const guildDir = path.join(baseDir, guildId);
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let skipped = 0;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(guildDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removed, skipped };
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      skipped += 1;
      continue;
    }

    if (entry.name === skipThreadId) {
      skipped += 1;
      continue;
    }

    const candidate = path.join(guildDir, entry.name);
    const stats = await walkStats(candidate);
    const updatedAt = stats.updatedAt?.getTime() ?? 0;
    if (updatedAt > 0 && updatedAt < cutoff) {
      await rm(candidate, { recursive: true, force: true });
      removed += 1;
    } else {
      skipped += 1;
    }
  }

  return { removed, skipped };
}

async function walkStats(dir: string): Promise<{ files: number; bytes: number; updatedAt?: Date }> {
  let files = 0;
  let bytes = 0;
  let updatedAt: Date | undefined;

  async function visit(current: string): Promise<void> {
    const currentStat = await stat(current);
    if (!updatedAt || currentStat.mtime > updatedAt) {
      updatedAt = currentStat.mtime;
    }

    if (currentStat.isFile()) {
      files += 1;
      bytes += currentStat.size;
      return;
    }

    if (!currentStat.isDirectory()) {
      return;
    }

    for (const entry of await readdir(current, { withFileTypes: true })) {
      await visit(path.join(current, entry.name));
    }
  }

  try {
    await visit(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return { files, bytes, updatedAt };
}
