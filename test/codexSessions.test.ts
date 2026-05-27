import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { findLatestCodexSessionIdForWorkspace } from "../src/codexSessions";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findLatestCodexSessionIdForWorkspace", () => {
  test("recovers the newest session id for a workspace cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-sessions-"));
    tempDirs.push(root);

    const workspaceDir = path.join(root, "workspace");
    const sessionDir = path.join(root, "codex-home", "sessions", "2026", "05", "27");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    await writeSessionFile(sessionDir, "old.jsonl", {
      id: "old-session",
      cwd: workspaceDir,
      timestamp: "2026-05-27T01:00:00.000Z"
    });
    await writeSessionFile(sessionDir, "new.jsonl", {
      id: "new-session",
      cwd: workspaceDir,
      timestamp: "2026-05-27T02:00:00.000Z"
    });
    await writeSessionFile(sessionDir, "other.jsonl", {
      id: "other-session",
      cwd: path.join(root, "other-workspace"),
      timestamp: "2026-05-27T03:00:00.000Z"
    });

    await expect(findLatestCodexSessionIdForWorkspace(workspaceDir, path.join(root, "codex-home")))
      .resolves.toBe("new-session");
  });
});

async function writeSessionFile(
  sessionDir: string,
  name: string,
  payload: { id: string; cwd: string; timestamp: string }
): Promise<void> {
  await writeFile(
    path.join(sessionDir, name),
    `${JSON.stringify({ type: "session_meta", payload })}\n`,
    "utf8"
  );
}
