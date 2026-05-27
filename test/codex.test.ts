import { describe, expect, test } from "bun:test";
import { buildCodexArgs, parseCodexJsonLine, type CodexParseState } from "../src/codex";

describe("buildCodexArgs", () => {
  test("builds first-run command with selected model and full access", () => {
    const args = buildCodexArgs({
      codexBin: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "hello",
      workspaceDir: "/tmp/workspace"
    });

    expect(args).toContain("exec");
    expect(args).toContain("-m");
    expect(args).toContain("gpt-5.5");
    expect(args).toContain(`model_reasoning_effort="high"`);
    expect(args).toContain("danger-full-access");
    expect(args).toContain("never");
    expect(args).toContain("/tmp/workspace");
  });

  test("includes image paths", () => {
    const args = buildCodexArgs({
      codexBin: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "hello",
      workspaceDir: "/tmp/workspace",
      imagePaths: ["/tmp/a.png"]
    });

    expect(args).toContain("-i");
    expect(args).toContain("/tmp/a.png");
  });

  test("builds resume command for known sessions", () => {
    const args = buildCodexArgs({
      codexBin: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "continue",
      workspaceDir: "/tmp/workspace",
      sessionId: "session-123"
    });

    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(args).toContain("session-123");
    expect(args).not.toContain("-C");
  });
});

describe("parseCodexJsonLine", () => {
  test("extracts session id and assistant content from item.completed", () => {
    const state: CodexParseState = { finalMessages: [], deltaMessages: [] };

    parseCodexJsonLine(
      JSON.stringify({
        type: "session.started",
        session_id: "abc"
      }),
      state
    );
    parseCodexJsonLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }]
        }
      }),
      state
    );

    expect(state.sessionId).toBe("abc");
    expect(state.finalMessages).toEqual(["done"]);
  });

  test("extracts agent message records", () => {
    const state: CodexParseState = { finalMessages: [], deltaMessages: [] };

    parseCodexJsonLine(
      JSON.stringify({
        type: "agent_message",
        message: "hello"
      }),
      state
    );

    expect(state.finalMessages).toEqual(["hello"]);
  });
});
