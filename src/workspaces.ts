import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexUsage } from "./codex";

export interface ThreadWorkspace {
  dir: string;
  sessionFile: string;
  jobStateFile: string;
  panelStateFile: string;
  usageStateFile: string;
  stateDir: string;
  attachmentsDir: string;
}

export interface GuildWorkspace {
  dir: string;
  stateDir: string;
  globalProfileFile: string;
}

export interface SessionState {
  sessionId?: string;
  sessionLogPath?: string;
  updatedAt: string;
}

export type StoredJobStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface StoredJobState {
  jobId: string;
  status: StoredJobStatus;
  phase: string;
  promptSummary: string;
  prompt?: string;
  threadId?: string;
  authorId?: string;
  authorName?: string;
  createdAt?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  queued?: number;
  messageIds?: string[];
  attachmentCount?: number;
  progress?: string[];
  recoveryAttempts?: number;
  usage?: CodexUsage;
}

export interface StoredThreadJobState {
  threadId: string;
  workspace: ThreadWorkspace;
  state: StoredJobState;
}

export interface PanelState {
  messageId: string;
  updatedAt: string;
}

export interface GlobalProfileState {
  content: string;
  updatedAt: string;
  authorId: string;
  authorName: string;
  sourceMessageId: string;
}

const stateDirName = ".codex-discord-agent";
const sessionFileName = "session.json";
const jobStateFileName = "last-job.json";
const panelStateFileName = "panel.json";
const usageStateFileName = "usage.json";
const globalProfileFileName = "global-profile.json";
const attachmentsDirName = "attachments";

export async function ensureGuildWorkspace(baseDir: string, guildId: string): Promise<GuildWorkspace> {
  const dir = path.join(baseDir, guildId);
  const stateDir = path.join(dir, stateDirName);
  await mkdir(stateDir, { recursive: true });

  return {
    dir,
    stateDir,
    globalProfileFile: path.join(stateDir, globalProfileFileName)
  };
}

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
    jobStateFile: path.join(stateDir, jobStateFileName),
    panelStateFile: path.join(stateDir, panelStateFileName),
    usageStateFile: path.join(stateDir, usageStateFileName),
    stateDir,
    attachmentsDir
  };
}

export async function loadGlobalProfileState(guildWorkspace: GuildWorkspace): Promise<GlobalProfileState | undefined> {
  try {
    const raw = await readFile(guildWorkspace.globalProfileFile, "utf8");
    const state = JSON.parse(raw) as GlobalProfileState;
    if (typeof state.content !== "string" || state.content.trim().length === 0) {
      return undefined;
    }
    return {
      content: state.content,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date(0).toISOString(),
      authorId: typeof state.authorId === "string" ? state.authorId : "unknown",
      authorName: typeof state.authorName === "string" ? state.authorName : "unknown",
      sourceMessageId: typeof state.sourceMessageId === "string" ? state.sourceMessageId : "unknown"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveGlobalProfileState(
  guildWorkspace: GuildWorkspace,
  state: Omit<GlobalProfileState, "updatedAt"> & { updatedAt?: string }
): Promise<GlobalProfileState> {
  const saved: GlobalProfileState = {
    ...state,
    content: state.content.trim(),
    updatedAt: state.updatedAt ?? new Date().toISOString()
  };
  await writeFile(guildWorkspace.globalProfileFile, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

export async function clearGlobalProfileState(guildWorkspace: GuildWorkspace): Promise<void> {
  await rm(guildWorkspace.globalProfileFile, { force: true });
}

export async function loadSessionState(workspace: ThreadWorkspace): Promise<SessionState | undefined> {
  try {
    const raw = await readFile(workspace.sessionFile, "utf8");
    const state = JSON.parse(raw) as SessionState;
    return {
      sessionId: typeof state.sessionId === "string" && state.sessionId.length > 0 ? state.sessionId : undefined,
      sessionLogPath: typeof state.sessionLogPath === "string" && state.sessionLogPath.length > 0
        ? state.sessionLogPath
        : undefined,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date(0).toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function loadSessionId(workspace: ThreadWorkspace): Promise<string | undefined> {
  return (await loadSessionState(workspace))?.sessionId;
}

export async function saveSessionId(
  workspace: ThreadWorkspace,
  sessionId: string,
  sessionLogPath?: string
): Promise<void> {
  const state: SessionState = {
    sessionId,
    sessionLogPath,
    updatedAt: new Date().toISOString()
  };
  await writeFile(workspace.sessionFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function resetSession(workspace: ThreadWorkspace): Promise<void> {
  await rm(workspace.sessionFile, { force: true });
}

export async function loadJobState(workspace: ThreadWorkspace): Promise<StoredJobState | undefined> {
  try {
    const raw = await readFile(workspace.jobStateFile, "utf8");
    const state = JSON.parse(raw) as StoredJobState;
    return typeof state.jobId === "string" ? state : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveJobState(workspace: ThreadWorkspace, state: StoredJobState): Promise<void> {
  await writeFile(workspace.jobStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function listStoredThreadJobStates(
  baseDir: string,
  guildId: string
): Promise<StoredThreadJobState[]> {
  const guildDir = path.join(baseDir, guildId);
  let entries;
  try {
    entries = await readdir(guildDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jobs: StoredThreadJobState[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === stateDirName) {
      continue;
    }
    const workspace = await ensureThreadWorkspace(baseDir, guildId, entry.name);
    const state = await loadJobState(workspace);
    if (state) {
      jobs.push({ threadId: entry.name, workspace, state });
    }
  }
  return jobs;
}

export async function loadPanelState(workspace: ThreadWorkspace): Promise<PanelState | undefined> {
  try {
    const raw = await readFile(workspace.panelStateFile, "utf8");
    const state = JSON.parse(raw) as PanelState;
    return typeof state.messageId === "string" && state.messageId.length > 0 ? state : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function savePanelState(workspace: ThreadWorkspace, messageId: string): Promise<void> {
  await writeFile(workspace.panelStateFile, `${JSON.stringify({
    messageId,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

export async function loadUsageState(workspace: ThreadWorkspace): Promise<CodexUsage | undefined> {
  try {
    return JSON.parse(await readFile(workspace.usageStateFile, "utf8")) as CodexUsage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveUsageState(workspace: ThreadWorkspace, usage: CodexUsage): Promise<void> {
  await writeFile(workspace.usageStateFile, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
}

export async function markJobInterrupted(workspace: ThreadWorkspace): Promise<StoredJobState | undefined> {
  const state = await loadJobState(workspace);
  if (!state || state.status !== "running") {
    return state;
  }

  const interrupted: StoredJobState = {
    ...state,
    status: "interrupted",
    phase: "interrupted",
    updatedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    error: "The service stopped before this job completed."
  };
  await saveJobState(workspace, interrupted);
  return interrupted;
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
