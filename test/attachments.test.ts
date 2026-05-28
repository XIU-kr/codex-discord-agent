import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { formatAttachmentPrompt, saveDiscordAttachments } from "../src/attachments";
import { ensureThreadWorkspace } from "../src/workspaces";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("attachments", () => {
  test("saves attachments with stable unique names", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-attachments-"));
    tempDirs.push(baseDir);
    const workspace = await ensureThreadWorkspace(baseDir, "guild", "thread");

    const result = await saveDiscordAttachments([
      {
        id: "att-1",
        name: "report.txt",
        url: "data:text/plain;base64,aGVsbG8=",
        size: 5,
        contentType: "text/plain"
      } as never
    ], workspace, "message-1", {
      maxFileBytes: 100,
      maxTotalBytes: 100
    });

    expect(result.failed).toEqual([]);
    expect(result.saved[0]?.path).toContain("att-1-report.txt");
    expect(result.saved[0]?.size).toBe(5);
  });

  test("records oversized attachments as partial failures", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-attachments-"));
    tempDirs.push(baseDir);
    const workspace = await ensureThreadWorkspace(baseDir, "guild", "thread");

    const result = await saveDiscordAttachments([
      {
        id: "att-1",
        name: "large.txt",
        url: "data:text/plain;base64,aGVsbG8=",
        size: 500,
        contentType: "text/plain"
      } as never
    ], workspace, "message-1", {
      maxFileBytes: 10,
      maxTotalBytes: 100
    });

    expect(result.saved).toEqual([]);
    expect(result.failed[0]?.originalName).toBe("large.txt");
    expect(formatAttachmentPrompt(result.saved, result.failed, "en")).toContain("failed");
  });
});
