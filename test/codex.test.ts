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

  test("extracts token usage from token count events", () => {
    const state: CodexParseState = { finalMessages: [], deltaMessages: [] };

    parseCodexJsonLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              output_tokens: 2,
              reasoning_output_tokens: 1,
              total_tokens: 12
            },
            last_token_usage: {
              input_tokens: 3,
              cached_input_tokens: 1,
              output_tokens: 2,
              reasoning_output_tokens: 0,
              total_tokens: 5
            },
            model_context_window: 100
          },
          rate_limits: {
            primary: { used_percent: 3, reset_at: "2026-05-29T00:00:00.000Z" },
            secondary: { used_percent: 5, window_seconds: 3600 },
            plan_type: "pro"
          }
        }
      }),
      state
    );

    expect(state.usage?.total?.totalTokens).toBe(12);
    expect(state.usage?.last?.inputTokens).toBe(3);
    expect(state.usage?.modelContextWindow).toBe(100);
    expect(state.usage?.rateLimits?.primaryUsedPercent).toBe(3);
    expect(state.usage?.rateLimits?.secondaryUsedPercent).toBe(5);
    expect(state.usage?.rateLimits?.primaryResetAt).toBe("2026-05-29T00:00:00.000Z");
    expect(state.usage?.rateLimits?.secondaryWindowMinutes).toBe(60);
    expect(state.usage?.rateLimits?.planType).toBe("pro");
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

  test("emits activity events for tool-like JSON records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-discord-agent-"));
    const bin = join(dir, "event-codex");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'exec_command', command: 'bun test' }));",
        "console.log(JSON.stringify({ type: 'agent_message', message: 'done' }));"
      ].join("\n"),
      "utf8"
    );
    await chmod(bin, 0o700);

    const events: string[] = [];
    const snapshots: string[] = [];
    const result = await runCodex({
      codexBin: bin,
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "hello",
      workspaceDir: dir,
      onEvent: (event) => events.push(`${event.phase}:${event.summary}`),
      onResponseSnapshot: (content) => snapshots.push(content)
    });

    expect(result.content).toBe("done");
    expect(events.some((event) => event.includes("Running tests"))).toBe(true);
    expect(snapshots).toContain("done");
  });
});
