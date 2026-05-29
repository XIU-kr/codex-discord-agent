import { describe, expect, test } from "bun:test";
import { commandNameFromAlias, parseThreadCommand } from "../src/threadCommands";

describe("thread commands", () => {
  test("parses concise English commands", () => {
    expect(parseThreadCommand("/status")).toEqual({ name: "status", args: [] });
    expect(parseThreadCommand("/settings")).toEqual({ name: "settings", args: [] });
    expect(parseThreadCommand("/usage")).toEqual({ name: "usage", args: [] });
    expect(parseThreadCommand("/logs")).toEqual({ name: "logs", args: [] });
    expect(parseThreadCommand("/shell sudo systemctl status codex-discord-agent")).toEqual({
      name: "shell",
      args: ["sudo", "systemctl", "status", "codex-discord-agent"],
      rawArgs: "sudo systemctl status codex-discord-agent"
    });
  });

  test("parses Korean command aliases", () => {
    expect(parseThreadCommand("/상태")).toEqual({ name: "status", args: [] });
    expect(parseThreadCommand("/설정")).toEqual({ name: "settings", args: [] });
    expect(parseThreadCommand("/사용량")).toEqual({ name: "usage", args: [] });
    expect(parseThreadCommand("/로그")).toEqual({ name: "logs", args: [] });
    expect(parseThreadCommand("/터미널 apt update")).toEqual({
      name: "shell",
      args: ["apt", "update"],
      rawArgs: "apt update"
    });
  });

  test("keeps legacy codex text commands", () => {
    expect(parseThreadCommand("/codex status")).toEqual({ name: "status", args: [] });
    expect(parseThreadCommand("codex 로그")).toEqual({ name: "logs", args: [] });
    expect(parseThreadCommand("codex shell git status --short")).toEqual({
      name: "shell",
      args: ["git", "status", "--short"],
      rawArgs: "git status --short"
    });
  });

  test("maps slash command aliases", () => {
    expect(commandNameFromAlias("status")).toBe("status");
    expect(commandNameFromAlias("상태")).toBe("status");
    expect(commandNameFromAlias("터미널")).toBe("shell");
  });
});
