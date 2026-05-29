import { t, type BotLanguage } from "./i18n";

export type ThreadCommandName =
  | "help"
  | "panel"
  | "settings"
  | "queue"
  | "doctor"
  | "usage"
  | "status"
  | "workspace"
  | "reset"
  | "stop"
  | "stop-current"
  | "logs"
  | "clean"
  | "shell";

export interface ThreadCommand {
  name: ThreadCommandName;
  args: string[];
  rawArgs?: string;
}

const commandAliases: Record<string, ThreadCommandName> = {
  help: "help",
  "도움말": "help",
  panel: "panel",
  controls: "panel",
  "패널": "panel",
  settings: "settings",
  config: "settings",
  setting: "settings",
  "설정": "settings",
  queue: "queue",
  q: "queue",
  "대기열": "queue",
  "큐": "queue",
  doctor: "doctor",
  check: "doctor",
  "진단": "doctor",
  "점검": "doctor",
  usage: "usage",
  tokens: "usage",
  "사용량": "usage",
  "토큰": "usage",
  status: "status",
  "상태": "status",
  workspace: "workspace",
  work: "workspace",
  "작업공간": "workspace",
  reset: "reset",
  "초기화": "reset",
  stop: "stop",
  cancel: "stop",
  "중단": "stop",
  "취소": "stop",
  "stop-current": "stop-current",
  stopcurrent: "stop-current",
  "현재중단": "stop-current",
  logs: "logs",
  log: "logs",
  "로그": "logs",
  clean: "clean",
  cleanup: "clean",
  "정리": "clean",
  shell: "shell",
  sh: "shell",
  terminal: "shell",
  "터미널": "shell",
  "쉘": "shell",
  "명령": "shell"
};

export function parseThreadCommand(content: string): ThreadCommand | undefined {
  const trimmed = content.trim();
  const codexMatch = trimmed.match(/^(?:\/codex|!codex|codex)(?:\s+(.+))?$/i);
  if (codexMatch) {
    const commandText = (codexMatch[1] ?? "help").trim();
    const parts = commandText.split(/\s+/).filter(Boolean);
    const requested = (parts.shift() ?? "help").toLowerCase();
    const name = commandAliases[requested];
    const rawArgs = commandText.slice(requested.length).trimStart();
    return name ? buildCommand(name, parts, rawArgs) : { name: "help", args: [] };
  }

  const directMatch = trimmed.match(/^\/?([\p{L}\p{N}_-]+)(?:\s+(.+))?$/u);
  if (!directMatch) {
    return undefined;
  }
  const requested = directMatch[1]?.toLowerCase() ?? "";
  const name = commandAliases[requested];
  if (!name) {
    return undefined;
  }
  const rawArgs = (directMatch[2] ?? "").trim();
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  return buildCommand(name, parts, rawArgs);
}

export function commandNameFromAlias(value: string): ThreadCommandName | undefined {
  return commandAliases[value.toLowerCase()];
}

export function formatCommandHelp(language: BotLanguage = "en"): string {
  return t(language).commandHelp.join("\n");
}

function buildCommand(name: ThreadCommandName, args: string[], rawArgs: string): ThreadCommand {
  return rawArgs ? { name, args, rawArgs } : { name, args };
}
