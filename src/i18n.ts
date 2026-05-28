export type BotLanguage = "en" | "ko";

export function parseLanguage(value: string | undefined): BotLanguage {
  return value?.trim().toLowerCase() === "ko" ? "ko" : "en";
}

const messages = {
  en: {
    emptyResponse: "_Codex returned an empty response._",
    responseTitle: "**Codex response**",
    runStart: "**Codex job started**",
    runComplete: "**Codex job completed**",
    runFailed: "**Codex job failed**",
    runStopped: "**Codex job stopped**",
    runRestarted: "**Codex job restarted**",
    longResponseFile: "**Codex response is long, so it is attached as a Markdown file.**",
    workspaceConnected: [
      "**Codex workspace connected**",
      "This thread now uses an isolated Codex workspace and session.",
      "Send a message to start Codex, or use `/codex help` for commands."
    ],
    denied: "You are not allowed to run Codex in this thread.",
    reset: "Reset this thread's Codex session. The next prompt will start a new session.",
    stopped: "Requested cancellation for the running Codex job and cleared the queue.",
    cleanDone: (removed: number, skipped: number) =>
      `Stale workspace cleanup complete: removed \`${removed}\`, skipped \`${skipped}\``,
    analyzeAttachments: "Analyze the attached files.",
    attachmentPromptIntro: "Attached files saved in the workspace:",
    attachmentKindImage: "image",
    attachmentKindFile: "file",
    replyInstruction: "When replying in Discord, prefer concise sections: Summary, Changes, Verification, Next.",
    combinedPromptIntro: "User messages to handle together:",
    statusTitle: "**Codex status**",
    workspaceTitle: "**Workspace**",
    logsTitle: "**Logs**",
    logsIntro: "Run one of these commands on the server to inspect logs.",
    labels: {
      workspace: "Workspace",
      model: "Model",
      reasoning: "Reasoning",
      session: "Session",
      queued: "Queued",
      elapsed: "Elapsed",
      idle: "No output",
      running: "Running",
      path: "Path",
      size: "Size",
      updated: "Updated"
    },
    values: {
      newSession: "new",
      unknown: "unknown",
      none: "none",
      yes: "yes",
      no: "no",
      files: (count: number) => `${count} files`
    },
    errorHintDefault: "Check the error below.",
    errorHintAuth: "This may be a Codex auth issue. Run `codex login` on the server.",
    errorHintPermission: "This may be a permission issue. Check workspace, Codex CLI, and systemd user permissions.",
    errorHintModel: "This may be a model configuration issue. Check `CODEX_MODEL` in `.env`.",
    errorHintEnv: "An environment variable is missing. Check your `.env` file.",
    errorHintStopped: "The run was stopped by user request.",
    commandHelp: [
      "**Codex commands**",
      "`/codex status` - Show this thread's job status.",
      "`/codex workspace` - Show workspace path and size.",
      "`/codex reset` - Start a fresh Codex session for this thread.",
      "`/codex stop` - Stop the running Codex job and clear the queue.",
      "`/codex logs` - Show server log commands.",
      "`/codex clean` - Remove stale workspaces.",
      "`/codex help` - Show this help."
    ]
  },
  ko: {
    emptyResponse: "_Codex가 빈 응답을 반환했습니다._",
    responseTitle: "**Codex 응답**",
    runStart: "**Codex 작업 시작**",
    runComplete: "**Codex 작업 완료**",
    runFailed: "**Codex 작업 실패**",
    runStopped: "**Codex 작업 중단**",
    runRestarted: "**Codex 작업 재시작**",
    longResponseFile: "**Codex 응답이 길어서 Markdown 파일로 첨부합니다.**",
    workspaceConnected: [
      "**Codex 작업 공간 연결됨**",
      "이 스레드는 독립된 Codex 작업 공간과 세션을 사용합니다.",
      "메시지를 보내면 Codex가 작업을 시작합니다. `/codex help`로 명령어를 볼 수 있습니다."
    ],
    denied: "이 스레드에서 Codex를 실행할 권한이 없습니다.",
    reset: "현재 스레드의 Codex 세션을 초기화했습니다. 다음 메시지는 새 세션으로 시작합니다.",
    stopped: "실행 중인 Codex 작업 중단을 요청했고 대기열을 비웠습니다.",
    cleanDone: (removed: number, skipped: number) =>
      `오래된 작업 공간 정리 완료: 삭제 \`${removed}\`, 건너뜀 \`${skipped}\``,
    analyzeAttachments: "첨부 파일을 분석하세요.",
    attachmentPromptIntro: "첨부 파일이 작업 공간에 저장되었습니다:",
    attachmentKindImage: "이미지",
    attachmentKindFile: "파일",
    replyInstruction: "Discord에 답할 때는 한국어로 답하고, 가능한 한 요약, 변경사항, 검증, 다음 단계 섹션으로 간결하게 답하세요.",
    combinedPromptIntro: "함께 처리할 사용자 메시지:",
    statusTitle: "**Codex 상태**",
    workspaceTitle: "**작업 공간**",
    logsTitle: "**로그**",
    logsIntro: "서버에서 다음 명령으로 로그를 확인하세요.",
    labels: {
      workspace: "작업 공간",
      model: "모델",
      reasoning: "추론",
      session: "세션",
      queued: "대기",
      elapsed: "소요 시간",
      idle: "무응답",
      running: "실행 중",
      path: "경로",
      size: "크기",
      updated: "갱신"
    },
    values: {
      newSession: "새 세션",
      unknown: "알 수 없음",
      none: "없음",
      yes: "예",
      no: "아니요",
      files: (count: number) => `${count}개 파일`
    },
    errorHintDefault: "아래 오류를 확인해 주세요.",
    errorHintAuth: "Codex 인증 문제일 수 있습니다. 서버에서 `codex login`을 실행해 주세요.",
    errorHintPermission: "권한 문제일 수 있습니다. 작업 공간, Codex CLI, systemd 실행 사용자 권한을 확인해 주세요.",
    errorHintModel: "모델 설정 문제일 수 있습니다. `.env`의 `CODEX_MODEL` 값을 확인해 주세요.",
    errorHintEnv: "환경변수 누락입니다. `.env` 설정을 확인해 주세요.",
    errorHintStopped: "사용자 요청으로 실행을 중단했습니다.",
    commandHelp: [
      "**Codex 명령어**",
      "`/codex status` - 현재 스레드의 작업 상태를 봅니다.",
      "`/codex workspace` - 작업 공간 경로와 크기를 봅니다.",
      "`/codex reset` - 현재 스레드의 Codex 세션을 새로 시작합니다.",
      "`/codex stop` - 실행 중인 Codex 작업을 중단하고 대기열을 비웁니다.",
      "`/codex logs` - systemd 로그 확인 명령을 보여줍니다.",
      "`/codex clean` - 오래된 작업 공간을 정리합니다.",
      "`/codex help` - 도움말을 봅니다."
    ]
  }
} as const;

export function t(language: BotLanguage): (typeof messages)[BotLanguage] {
  return messages[language];
}
