import { describe, expect, spyOn, test } from "bun:test";
import { sendThreadMessage } from "../src/discordApi";

describe("discordApi", () => {
  test("retries failed thread sends", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let attempts = 0;
      const thread = {
        id: "thread-1",
        send: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary failure");
          }
          return { id: "message-1", channelId: "thread-1" };
        }
      };

      const message = await sendThreadMessage(thread as never, { content: "hello" }, { retries: 1, timeoutMs: 100 }, {
        action: "test",
        threadId: "thread-1"
      });

      expect(message.id).toBe("message-1");
      expect(attempts).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});
