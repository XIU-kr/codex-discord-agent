import { describe, expect, test } from "bun:test";
import {
  formatCodexResponse,
  formatDuration,
  formatError,
  formatRunComplete,
  formatRunCompleteMessage,
  formatRunHeader,
  formatRunRestartedMessage,
  formatRunStartMessage,
  formatStatusMessage,
  formatWorkspaceMessage
} from "../src/discordFormat";
import { parseLanguage } from "../src/i18n";
import { formatCommandHelp } from "../src/threadCommands";

describe("i18n", () => {
  test("defaults to English", () => {
    expect(parseLanguage(undefined)).toBe("en");
    expect(parseLanguage("fr")).toBe("en");
  });

  test("supports Korean", () => {
    expect(parseLanguage("ko")).toBe("ko");
    expect(formatCodexResponse("hello", "ko")).toBe("hello");
    expect(formatCommandHelp("ko")).toContain("Codex 명령어");
    expect(formatCommandHelp("ko")).toContain("/상태");
  });

  test("formats Korean run metadata", () => {
    expect(
      formatRunHeader(
        {
          workspaceDir: "/tmp/work",
          model: "gpt-5.5",
          reasoningEffort: "high",
          queued: 0
        },
        "ko"
      )
    ).toContain("작업 공간");

    expect(
      formatRunComplete(
        {
          elapsedMs: 11_000,
          files: 0,
          bytes: 0
        },
        "ko"
      )
    ).toContain("소요 시간: `11초`");

    expect(formatDuration(61_000, "ko")).toBe("1분 1초");
  });

  test("formats Korean status messages", () => {
    expect(
      formatRunStartMessage(
        {
          workspaceDir: "/tmp/work",
          model: "gpt-5.5",
          reasoningEffort: "high",
          queued: 1
        },
        "ko"
      ).title
    ).toBe("Codex 작업 시작");

    expect(formatRunCompleteMessage({ elapsedMs: 11_000 }, "ko").fields?.[0]?.value).toBe("`11초`");
    expect(formatRunRestartedMessage({ elapsedMs: 11_000, queued: 2 }, "ko").title).toBe("Codex 작업 재시작");
    expect(formatStatusMessage({ running: true, elapsedMs: 61_000, queued: 0 }, "ko").title).toBe("Codex 상태");
    expect(formatWorkspaceMessage({ path: "/tmp/work", files: 2, bytes: 1024 }, "ko").fields?.[2]?.value)
      .toContain("2개 파일");
  });

  test("formats English status and errors", () => {
    expect(
      formatRunHeader(
        {
          workspaceDir: "/tmp/work",
          model: "gpt-5.5",
          reasoningEffort: "high",
          queued: 0
        },
        "en"
      )
    ).toContain("Codex job started");
    expect(formatError(new Error("auth failed"), "en")).toContain("codex login");
  });
});
