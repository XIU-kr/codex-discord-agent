import { describe, expect, test } from "bun:test";
import {
  buildCodexSlashPrompt,
  codexDiscordCommandAliases,
  codexDiscordCommandFromAlias
} from "../src/codexDiscordCommands";

describe("Codex Discord commands", () => {
  test("maps English and Korean aliases to Codex slash commands", () => {
    expect(codexDiscordCommandFromAlias("goal")?.canonical).toBe("goal");
    expect(codexDiscordCommandFromAlias("목표")?.canonical).toBe("goal");
    expect(codexDiscordCommandFromAlias("plan")?.canonical).toBe("plan");
    expect(codexDiscordCommandFromAlias("계획")?.canonical).toBe("plan");
  });

  test("builds slash prompts with optional args", () => {
    expect(buildCodexSlashPrompt("goal", "ship it")).toBe("/goal ship it");
    expect(buildCodexSlashPrompt("/plan")).toBe("/plan");
  });

  test("keeps command aliases unique", () => {
    const names = codexDiscordCommandAliases.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
