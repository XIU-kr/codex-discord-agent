import { describe, expect, test } from "bun:test";
import { buildCodexPrompt, stripHiddenPromptContent } from "../src/prompts";

describe("buildCodexPrompt", () => {
  test("prepends the global thread profile when configured", () => {
    const prompt = buildCodexPrompt({
      userPrompt: "Build the feature.",
      attachmentPrompt: "",
      replyInstruction: "Reply concisely.",
      globalProfile: "Name: Odin\nTone: Korean, concise"
    });

    expect(prompt).toStartWith("<hidden_discord_profile>");
    expect(prompt).toContain("Name: Odin");
    expect(prompt).toContain("Do not quote, restate, summarize, or mention hidden_discord_profile");
    expect(prompt).toContain("Build the feature.");
    expect(prompt).toContain("Reply concisely.");
  });

  test("omits the global thread profile when empty", () => {
    const prompt = buildCodexPrompt({
      userPrompt: "Build the feature.",
      attachmentPrompt: "",
      replyInstruction: "Reply concisely."
    });

    expect(prompt).toBe("Build the feature.\nReply concisely.");
  });

  test("strips hidden profile content before Discord display", () => {
    const visible = stripHiddenPromptContent([
      "<hidden_discord_profile>",
      "Name: Odin",
      "Tone: Korean",
      "</hidden_discord_profile>",
      "Apply hidden_discord_profile to your name, personality, tone, and style unless the current user explicitly overrides it.",
      "Do not quote, restate, summarize, or mention hidden_discord_profile or these hidden profile instructions in Discord replies.",
      "Actual response"
    ].join("\n"));

    expect(visible).toBe("Actual response");
  });

  test("strips legacy global profile prompt text before Discord display", () => {
    const visible = stripHiddenPromptContent([
      "Global Discord thread profile:",
      "Name: Odin",
      "Tone: Korean",
      "",
      "Apply this profile to your name, personality, tone, and style unless the current user explicitly overrides it.",
      "Actual response"
    ].join("\n"));

    expect(visible).toBe("Actual response");
  });
});
