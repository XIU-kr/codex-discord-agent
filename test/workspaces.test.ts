import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearGlobalProfileState,
  ensureGuildWorkspace,
  ensureThreadWorkspace,
  getWorkspaceStats,
  loadGlobalProfileState,
  loadJobState,
  loadPanelState,
  loadSessionId,
  loadSessionState,
  loadUsageState,
  markJobInterrupted,
  resetSession,
  saveGlobalProfileState,
  saveJobState,
  savePanelState,
  saveSessionId,
  saveUsageState
} from "../src/workspaces";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("thread workspaces", () => {
  test("persists global profile state per guild", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-agent-"));
    tempDirs.push(baseDir);

    const guildWorkspace = await ensureGuildWorkspace(baseDir, "guild");
    expect(await loadGlobalProfileState(guildWorkspace)).toBeUndefined();

    await saveGlobalProfileState(guildWorkspace, {
      content: "Name: Helper\nTone: concise",
      authorId: "user-1",
      authorName: "User",
      sourceMessageId: "message-1"
    });

    const loaded = await loadGlobalProfileState(guildWorkspace);
    expect(loaded?.content).toContain("Tone: concise");
    expect(loaded?.authorName).toBe("User");

    await clearGlobalProfileState(guildWorkspace);
    expect(await loadGlobalProfileState(guildWorkspace)).toBeUndefined();
  });

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

  test("persists control panel message ids", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-agent-"));
    tempDirs.push(baseDir);

    const workspace = await ensureThreadWorkspace(baseDir, "guild", "thread");
    await savePanelState(workspace, "message-123");

    expect((await loadPanelState(workspace))?.messageId).toBe("message-123");
  });

  test("persists Codex usage state", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-agent-"));
    tempDirs.push(baseDir);

    const workspace = await ensureThreadWorkspace(baseDir, "guild", "thread");
    await saveUsageState(workspace, {
      total: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 12
      },
      modelContextWindow: 100,
      rateLimits: {
        primaryUsedPercent: 3,
        planType: "pro"
      }
    });

    const usage = await loadUsageState(workspace);

    expect(usage?.total?.totalTokens).toBe(12);
    expect(usage?.rateLimits?.planType).toBe("pro");
  });
});
