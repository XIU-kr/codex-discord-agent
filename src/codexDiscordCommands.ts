export interface CodexDiscordCommandAlias {
  name: string;
  canonical: string;
  description: {
    en: string;
    ko: string;
  };
}

export const codexDiscordCommandAliases: CodexDiscordCommandAlias[] = [
  alias("goal", "goal", "Send Codex /goal.", "Codex /goal을 실행합니다."),
  alias("목표", "goal", "Send Codex /goal.", "Codex /goal을 실행합니다."),
  alias("plan", "plan", "Send Codex /plan.", "Codex /plan을 실행합니다."),
  alias("계획", "plan", "Send Codex /plan.", "Codex /plan을 실행합니다."),
  alias("compact", "compact", "Send Codex /compact.", "Codex /compact를 실행합니다."),
  alias("압축", "compact", "Send Codex /compact.", "Codex /compact를 실행합니다."),
  alias("model", "model", "Send Codex /model.", "Codex /model을 실행합니다."),
  alias("모델", "model", "Send Codex /model.", "Codex /model을 실행합니다."),
  alias("approvals", "approvals", "Send Codex /approvals.", "Codex /approvals를 실행합니다."),
  alias("승인", "approvals", "Send Codex /approvals.", "Codex /approvals를 실행합니다."),
  alias("mode", "mode", "Send Codex /mode.", "Codex /mode를 실행합니다."),
  alias("모드", "mode", "Send Codex /mode.", "Codex /mode를 실행합니다."),
  alias("init", "init", "Send Codex /init.", "Codex /init을 실행합니다."),
  alias("초기설정", "init", "Send Codex /init.", "Codex /init을 실행합니다."),
  alias("review", "review", "Send Codex /review.", "Codex /review를 실행합니다."),
  alias("리뷰", "review", "Send Codex /review.", "Codex /review를 실행합니다."),
  alias("diff", "diff", "Send Codex /diff.", "Codex /diff를 실행합니다."),
  alias("변경사항", "diff", "Send Codex /diff.", "Codex /diff를 실행합니다."),
  alias("undo", "undo", "Send Codex /undo.", "Codex /undo를 실행합니다."),
  alias("되돌리기", "undo", "Send Codex /undo.", "Codex /undo를 실행합니다."),
  alias("new", "new", "Send Codex /new.", "Codex /new를 실행합니다."),
  alias("새작업", "new", "Send Codex /new.", "Codex /new를 실행합니다."),
  alias("context", "context", "Send Codex /context.", "Codex /context를 실행합니다."),
  alias("컨텍스트", "context", "Send Codex /context.", "Codex /context를 실행합니다."),
  alias("mention", "mention", "Send Codex /mention.", "Codex /mention을 실행합니다."),
  alias("멘션", "mention", "Send Codex /mention.", "Codex /mention을 실행합니다.")
];

const codexAliasMap = new Map(codexDiscordCommandAliases.map((entry) => [entry.name, entry]));

export function codexDiscordCommandFromAlias(name: string): CodexDiscordCommandAlias | undefined {
  return codexAliasMap.get(name.toLowerCase());
}

export function buildCodexSlashPrompt(command: string, args = ""): string {
  const normalizedCommand = command.trim().replace(/^\/+/, "");
  const normalizedArgs = args.trim();
  return normalizedArgs ? `/${normalizedCommand} ${normalizedArgs}` : `/${normalizedCommand}`;
}

function alias(name: string, canonical: string, en: string, ko: string): CodexDiscordCommandAlias {
  return {
    name,
    canonical,
    description: { en, ko }
  };
}
