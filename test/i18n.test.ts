import { describe, expect, test } from "bun:test";
import { formatCodexResponse, formatError, formatRunHeader } from "../src/discordFormat";
import { parseLanguage } from "../src/i18n";
import { formatCommandHelp } from "../src/threadCommands";

describe("i18n", () => {
  test("defaults to English", () => {
    expect(parseLanguage(undefined)).toBe("en");
    expect(parseLanguage("fr")).toBe("en");
  });

  test("supports Korean", () => {
    expect(parseLanguage("ko")).toBe("ko");
    expect(formatCodexResponse("hello", "ko")).toStartWith("**Codex 응답**");
    expect(formatCommandHelp("ko")).toContain("Codex 명령어");
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
