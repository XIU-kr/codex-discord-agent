import { describe, expect, test } from "bun:test";
import { runShellCommand, validateShellCommand } from "../src/shellCommands";

describe("shell commands", () => {
  test("runs a command and captures output", async () => {
    const snapshots: string[] = [];
    const result = await runShellCommand("printf 'hello'", {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 10_000,
      onOutput: (snapshot) => snapshots.push(snapshot.output)
    });

    expect(result.blockedReason).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(snapshots).toContain("hello");
  });

  test("captures non-zero exits", async () => {
    const result = await runShellCommand("printf 'bad' >&2; exit 7", {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 10_000
    });

    expect(result.exitCode).toBe(7);
    expect(result.output).toBe("bad");
  });

  test("times out long-running commands", async () => {
    const result = await runShellCommand("sleep 2", {
      cwd: process.cwd(),
      timeoutMs: 50,
      maxOutputBytes: 10_000
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  test("truncates long output", async () => {
    const result = await runShellCommand("printf '1234567890'", {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputBytes: 5
    });

    expect(result.output).toBe("12345");
    expect(result.truncated).toBe(true);
  });

  test("blocks destructive commands", () => {
    expect(validateShellCommand("sudo rm -rf /")).toContain("root");
    expect(validateShellCommand("rm -rf /*")).toContain("root");
    expect(validateShellCommand(":(){ :|:& };:")).toContain("fork bomb");
    expect(validateShellCommand("mkfs.ext4 /dev/sda1")).toContain("format");
    expect(validateShellCommand("dd if=/dev/zero of=/dev/sda bs=1M")).toContain("block device");
  });
});
