import { describe, expect, test } from "bun:test";
import { buildCodexPrompt } from "../src/prompts";

describe("buildCodexPrompt", () => {
  test("prepends the global thread profile when configured", () => {
    const prompt = buildCodexPrompt({
      userPrompt: "Build the feature.",
      attachmentPrompt: "",
      replyInstruction: "Reply concisely.",
      globalProfile: "Name: Odin\nTone: Korean, concise"
    });

    expect(prompt).toStartWith("Global Discord thread profile:");
    expect(prompt).toContain("Name: Odin");
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
});
