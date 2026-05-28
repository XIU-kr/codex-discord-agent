import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs, parseCodexJsonLine, runCodex, type CodexParseState } from "../src/codex";

describe("buildCodexArgs", () => {
  test("builds first-run command with selected model and full access", () => {
    const args = buildCodexArgs({
      codexBin: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "hello",
      workspaceDir: "/tmp/workspace"
    });

    expect(args).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-5.5",
      "-c",
      `model_reasoning_effort="high"`,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "-"
    ]);
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
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
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

  test("extracts session id from session metadata payload", () => {
    const state: CodexParseState = { finalMessages: [], deltaMessages: [] };

    parseCodexJsonLine(
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "session-from-meta",
          cwd: "/tmp/workspace"
        }
      }),
      state
    );

    expect(state.sessionId).toBe("session-from-meta");
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

  test("extracts agent messages nested in event payloads", () => {
    const state: CodexParseState = { finalMessages: [], deltaMessages: [] };

    parseCodexJsonLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "still working"
        }
      }),
      state
    );

    expect(state.finalMessages).toEqual(["still working"]);
  });

  test("extracts assistant messages nested in response item payloads", () => {
    const state: CodexParseState = { finalMessages: [], deltaMessages: [] };

    parseCodexJsonLine(
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }]
        }
      }),
      state
    );

    expect(state.finalMessages).toEqual(["done"]);
  });
});

describe("runCodex watchdogs", () => {
  test("stops a Codex process that produces no output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-discord-agent-"));
    const bin = join(dir, "silent-codex");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.on('SIGINT', () => process.exit(130));",
        "setInterval(() => {}, 1000);"
      ].join("\n"),
      "utf8"
    );
    await chmod(bin, 0o700);

    let error: unknown;
    try {
      await runCodex({
        codexBin: bin,
        model: "gpt-5.5",
        reasoningEffort: "high",
        prompt: "hello",
        workspaceDir: dir,
        idleTimeoutMs: 50
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("no output");
  });
});
