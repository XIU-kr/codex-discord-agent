import { describe, expect, test } from "bun:test";
import { splitDiscordMessage } from "../src/discordFormat";

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
});
