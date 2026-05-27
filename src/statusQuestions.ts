export function isStatusQuestion(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120) {
    return false;
  }

  const compact = normalized.replace(/\s+/g, "");
  const koreanPatterns = [
    /얼마나.*남/,
    /남았/,
    /언제.*끝/,
    /몇(분|초|시간)/,
    /(진행|지금|작업).*상태/,
    /멈췄/,
    /멈춘/,
    /안대답/,
    /대답안/,
    /작성중/
  ];

  if (koreanPatterns.some((pattern) => pattern.test(compact))) {
    return true;
  }

  return /\b(status|eta|progress|stuck|hung|frozen)\b/.test(normalized) ||
    /\bhow long\b/.test(normalized) ||
    /\bstill running\b/.test(normalized) ||
    /\bare you there\b/.test(normalized);
}
