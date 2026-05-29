import { describe, expect, test } from "bun:test";
import { formatCodexResponse, formatStatusEmbed, formatUsageEmbed, splitDiscordMessage, summarizeLongResponse } from "../src/discordFormat";

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

  test("formats compact job status with progress", () => {
    const embed = formatStatusEmbed({
      running: true,
      jobId: "job-1",
      phase: "tool",
      lastEvent: "Tool activity: test",
      timeoutAt: Date.now() + 10_000,
      elapsedMs: 1_000,
      idleMs: 500,
      queued: 2,
      queueSummary: "**1.** user: prompt",
      progress: ["Workspace is ready.", "Running tests: bun test"]
    }, "en");

    expect(embed.fields?.some((field) => field.name === "Phase" && field.value.includes("Using tools"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Last event")).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Progress" && field.value.includes("bun test"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Job")).toBe(false);
    expect(embed.fields?.some((field) => field.name === "Timeline")).toBe(false);
  });

  test("does not add a repeated response title", () => {
    expect(formatCodexResponse("hello", "en")).toBe("hello");
    expect(formatCodexResponse("안녕하세요", "ko")).toBe("안녕하세요");
  });

  test("formats Codex usage details", () => {
    const embed = formatUsageEmbed({
      total: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 12
      },
      last: {
        inputTokens: 3,
        cachedInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 0,
        totalTokens: 5
      },
      modelContextWindow: 100,
      rateLimits: {
        primaryUsedPercent: 3,
        secondaryUsedPercent: 5,
        primaryResetAt: "2026-05-29T00:00:00.000Z",
        planType: "pro"
      }
    }, "en");

    expect(embed.title).toBe("Codex usage");
    expect(embed.fields?.some((field) => field.name === "Total tokens" && field.value.includes("12"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Rate limits" && field.value.includes("primary 3%"))).toBe(true);
    expect(embed.fields?.some((field) => field.name === "Resets" && field.value.includes("2026-05-29"))).toBe(true);
  });

  test("summarizes long file responses", () => {
    const summary = summarizeLongResponse("a".repeat(2000), "en");

    expect(summary).toContain("attached as a Markdown file");
    expect(summary.length).toBeLessThan(1400);
  });
});
