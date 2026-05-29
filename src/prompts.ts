export function buildCodexPrompt(options: {
  userPrompt: string;
  attachmentPrompt: string;
  replyInstruction: string;
  globalProfile?: string;
}): string {
  return [
    formatGlobalProfilePrompt(options.globalProfile),
    options.userPrompt,
    options.attachmentPrompt,
    options.replyInstruction
  ].filter((part) => part.trim().length > 0).join("\n");
}

function formatGlobalProfilePrompt(globalProfile: string | undefined): string {
  const normalized = globalProfile?.trim();
  if (!normalized) {
    return "";
  }
  return [
    "Global Discord thread profile:",
    normalized,
    "",
    "Apply this profile to your name, personality, tone, and style unless the current user explicitly overrides it."
  ].join("\n");
}
