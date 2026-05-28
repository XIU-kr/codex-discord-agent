import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import type { ThreadWorkspace } from "./workspaces";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export async function runDoctor(config: AppConfig, workspace: ThreadWorkspace): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = await runCommand(config.codexBin, ["--version"]);
  checks.push({
    name: "Codex CLI",
    status: version.ok ? "ok" : "fail",
    detail: version.output || `Could not run ${config.codexBin}.`
  });

  if (version.ok) {
    const login = await runCommand(config.codexBin, ["login", "status"]);
    checks.push({
      name: "Codex auth",
      status: login.ok ? "ok" : "fail",
      detail: login.output || "Run codex login as the service user."
    });
  } else {
    checks.push({
      name: "Codex auth",
      status: "fail",
      detail: "Skipped because Codex CLI is not runnable."
    });
  }

  checks.push(await checkWorkspaceWritable(workspace));
  checks.push({
    name: "Model",
    status: "ok",
    detail: `${config.codexModel} / ${config.codexReasoningEffort}`
  });
  checks.push({
    name: "Discord allowlist",
    status: config.allowedUserIds.length === 0 && config.allowedRoleIds.length === 0 ? "warn" : "ok",
    detail: config.allowedUserIds.length === 0 && config.allowedRoleIds.length === 0
      ? "No allowlist is configured."
      : `${config.allowedUserIds.length} users, ${config.allowedRoleIds.length} roles`
  });

  return checks;
}

async function checkWorkspaceWritable(workspace: ThreadWorkspace): Promise<DoctorCheck> {
  const filePath = path.join(workspace.stateDir, `doctor-${Date.now()}.tmp`);
  try {
    await writeFile(filePath, "ok", "utf8");
    await rm(filePath, { force: true });
    return {
      name: "Workspace",
      status: "ok",
      detail: workspace.dir
    };
  } catch (error) {
    return {
      name: "Workspace",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runCommand(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}
