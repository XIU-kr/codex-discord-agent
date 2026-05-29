import { describe, expect, test } from "bun:test";
import { commandNameFromAlias, parseThreadCommand } from "../src/threadCommands";

describe("thread commands", () => {
  test("parses concise English commands", () => {
    expect(parseThreadCommand("/status")).toEqual({ name: "status", args: [] });
    expect(parseThreadCommand("/settings")).toEqual({ name: "settings", args: [] });
    expect(parseThreadCommand("/usage")).toEqual({ name: "usage", args: [] });
    expect(parseThreadCommand("/logs")).toEqual({ name: "logs", args: [] });
  });

  test("parses Korean command aliases", () => {
    expect(parseThreadCommand("/상태")).toEqual({ name: "status", args: [] });
    expect(parseThreadCommand("/설정")).toEqual({ name: "settings", args: [] });
    expect(parseThreadCommand("/사용량")).toEqual({ name: "usage", args: [] });
    expect(parseThreadCommand("/로그")).toEqual({ name: "logs", args: [] });
  });

  test("keeps legacy codex text commands", () => {
    expect(parseThreadCommand("/codex status")).toEqual({ name: "status", args: [] });
    expect(parseThreadCommand("codex 로그")).toEqual({ name: "logs", args: [] });
  });

  test("maps slash command aliases", () => {
    expect(commandNameFromAlias("status")).toBe("status");
    expect(commandNameFromAlias("상태")).toBe("status");
  });
});
