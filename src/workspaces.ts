import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ThreadWorkspace {
  dir: string;
  sessionFile: string;
}

interface SessionState {
  sessionId?: string;
  updatedAt: string;
}

const stateDirName = ".codex-discord-agent";
const sessionFileName = "session.json";

export async function ensureThreadWorkspace(
  baseDir: string,
  guildId: string,
  threadId: string
): Promise<ThreadWorkspace> {
  const dir = path.join(baseDir, guildId, threadId);
  const stateDir = path.join(dir, stateDirName);
  await mkdir(stateDir, { recursive: true });

  return {
    dir,
    sessionFile: path.join(stateDir, sessionFileName)
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
