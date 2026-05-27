export const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_CHUNK_LIMIT = 1900;

export function splitDiscordMessage(input: string, limit = DEFAULT_CHUNK_LIMIT): string[] {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return ["_Codex returned an empty response._"];
  }

  const chunks: string[] = [];
  const lines = normalized.split("\n");
  let current = "";
  let activeFenceLang: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const isLast = index === lines.length - 1;
    const line = lines[index] ?? "";
    const piece = `${line}${isLast ? "" : "\n"}`;

    if (piece.length > limit) {
      flushChunk();
      for (const hardChunk of splitLongPiece(piece, limit, activeFenceLang)) {
        chunks.push(hardChunk);
      }
      updateFence(line);
      continue;
    }

    const reservedFenceClose = activeFenceLang ? "\n```".length : 0;
    if (current.length + piece.length + reservedFenceClose > limit) {
      flushChunk();
    }

    current += piece;
    updateFence(line);
  }

  flushChunk();
  return chunks;

  function flushChunk(): void {
    const body = current.trimEnd();
    if (!body) {
      current = activeFenceLang ? `\`\`\`${activeFenceLang}\n` : "";
      return;
    }

    chunks.push(activeFenceLang ? `${body}\n\`\`\`` : body);
    current = activeFenceLang ? `\`\`\`${activeFenceLang}\n` : "";
  }

  function updateFence(line: string): void {
    const match = line.match(/^```(\S*)?/);
    if (!match) {
      return;
    }
    activeFenceLang = activeFenceLang ? undefined : match[1] ?? "";
  }
}

function splitLongPiece(piece: string, limit: number, activeFenceLang: string | undefined): string[] {
  const chunks: string[] = [];
  const prefix = activeFenceLang ? `\`\`\`${activeFenceLang}\n` : "";
  const suffix = activeFenceLang ? "\n```" : "";
  const available = limit - prefix.length - suffix.length;

  for (let offset = 0; offset < piece.length; offset += available) {
    const body = piece.slice(offset, offset + available).trimEnd();
    if (body.length > 0) {
      chunks.push(`${prefix}${body}${suffix}`);
    }
  }

  return chunks;
}

export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const clipped = message.length > 1500 ? `${message.slice(0, 1500)}...` : message;
  return `**Codex 실행 실패**\n\`\`\`\n${clipped}\n\`\`\``;
}
