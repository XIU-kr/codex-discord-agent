import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ensureThreadWorkspace,
  getWorkspaceStats,
  loadJobState,
  loadSessionId,
  loadSessionState,
  markJobInterrupted,
  resetSession,
  saveJobState,
  saveSessionId
} from "../src/workspaces";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("thread workspaces", () => {
  test("creates stable workspace paths and persists session ids", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-agent-"));
    tempDirs.push(baseDir);

    const workspace = await ensureThreadWorkspace(baseDir, "guild", "thread");
    expect(workspace.dir).toBe(path.join(baseDir, "guild", "thread"));
    expect(await loadSessionId(workspace)).toBeUndefined();

    await saveSessionId(workspace, "session-1");

    expect(await loadSessionId(workspace)).toBe("session-1");
    await saveSessionId(workspace, "session-1", "/tmp/session.jsonl");
    expect((await loadSessionState(workspace))?.sessionLogPath).toBe("/tmp/session.jsonl");
    expect(await readFile(workspace.sessionFile, "utf8")).toContain("session-1");

    const stats = await getWorkspaceStats(workspace);
    expect(stats.files).toBeGreaterThan(0);

    await resetSession(workspace);
    expect(await loadSessionId(workspace)).toBeUndefined();
  });

  test("persists and interrupts running job state", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-agent-"));
    tempDirs.push(baseDir);

    const workspace = await ensureThreadWorkspace(baseDir, "guild", "thread");
    await saveJobState(workspace, {
      jobId: "job-1",
      status: "running",
      phase: "codex",
      promptSummary: "hello",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect((await loadJobState(workspace))?.status).toBe("running");
    expect((await markJobInterrupted(workspace))?.status).toBe("interrupted");
    expect((await loadJobState(workspace))?.phase).toBe("interrupted");
  });
});
