import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Attachment } from "discord.js";
import type { ThreadWorkspace } from "./workspaces";

export interface SavedAttachment {
  originalName: string;
  path: string;
  contentType?: string;
  isImage: boolean;
}

export async function saveDiscordAttachments(
  attachments: Iterable<Attachment>,
  workspace: ThreadWorkspace,
  messageId: string
): Promise<SavedAttachment[]> {
  const saved: SavedAttachment[] = [];
  const targetDir = path.join(workspace.attachmentsDir, messageId);
  await mkdir(targetDir, { recursive: true });

  for (const attachment of attachments) {
    const fileName = sanitizeFileName(attachment.name ?? attachment.id);
    const targetPath = path.join(targetDir, fileName);
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment ${attachment.name}: ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(targetPath, bytes);

    const contentType = attachment.contentType ?? response.headers.get("content-type") ?? undefined;
    saved.push({
      originalName: attachment.name ?? attachment.id,
      path: targetPath,
      contentType,
      isImage: isImageAttachment(contentType, targetPath)
    });
  }

  return saved;
}

export function formatAttachmentPrompt(attachments: SavedAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const lines = attachments.map((attachment) => {
    const kind = attachment.isImage ? "image" : "file";
    return `- ${attachment.originalName} (${kind}): ${attachment.path}`;
  });

  return `\n\nAttached files saved in the workspace:\n${lines.join("\n")}\n`;
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
}

function isImageAttachment(contentType: string | undefined, filePath: string): boolean {
  if (contentType?.startsWith("image/")) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(filePath);
}
