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
  | "clean";

export interface ThreadCommand {
  name: ThreadCommandName;
  args: string[];
}

const commandAliases: Record<string, ThreadCommandName> = {
  help: "help",
  panel: "panel",
  controls: "panel",
  settings: "settings",
  config: "settings",
  queue: "queue",
  q: "queue",
  doctor: "doctor",
  check: "doctor",
  usage: "usage",
  tokens: "usage",
  status: "status",
  workspace: "workspace",
  reset: "reset",
  stop: "stop",
  cancel: "stop",
  "stop-current": "stop-current",
  stopcurrent: "stop-current",
  logs: "logs",
  clean: "clean",
  cleanup: "clean"
};

export function parseThreadCommand(content: string): ThreadCommand | undefined {
  const trimmed = content.trim();
  const match = trimmed.match(/^(?:\/codex|!codex|codex)(?:\s+(.+))?$/i);
  if (!match) {
    return undefined;
  }

  const parts = (match[1] ?? "help").trim().split(/\s+/).filter(Boolean);
  const requested = (parts.shift() ?? "help").toLowerCase();
  const name = commandAliases[requested];
  if (!name) {
    return { name: "help", args: [] };
  }

  return { name, args: parts };
}

export function formatCommandHelp(language: BotLanguage = "en"): string {
  return t(language).commandHelp.join("\n");
}
