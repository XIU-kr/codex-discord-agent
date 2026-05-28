import { describe, expect, test } from "bun:test";
import { formatStatusEmbed, splitDiscordMessage, summarizeLongResponse } from "../src/discordFormat";

describe("splitDiscordMessage", () => {
  test("returns a friendly empty response", () => {
    expect(splitDiscordMessage("")).toEqual(["_Codex returned an empty response._"]);
  });

  test("splits long messages under the limit", () => {
    const chunks = splitDiscordMessage("a".repeat(4500), 1000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });

  test("keeps code fences balanced across chunks", () => {
    const input = `Before\n\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\`\nAfter`;
    const chunks = splitDiscordMessage(input, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    for (const chunk of chunks) {
      const fenceCount = chunk.match(/```/g)?.length ?? 0;
      expect(fenceCount % 2).toBe(0);
    }
  });

  test("formats detailed job status", () => {
    const embed = formatStatusEmbed({
      running: true,
      jobId: "job-1",
      phase: "tool",
      lastEvent: "Tool activity: test",
      timeoutAt: Date.now() + 10_000,
      elapsedMs: 1_000,
      idleMs: 500,
      queued: 2,
      queueSummary: "**1.** user: prompt"
    }, "en");

    expect(embed.fields?.some((field) => field.name === "Phase" && field.value.includes("Using tools"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Last event")).toBe(true);
  });

  test("summarizes long file responses", () => {
    const summary = summarizeLongResponse("a".repeat(2000), "en");

    expect(summary).toContain("attached as a Markdown file");
    expect(summary.length).toBeLessThan(1400);
  });
});
