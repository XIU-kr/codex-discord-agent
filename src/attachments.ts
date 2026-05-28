import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Attachment } from "discord.js";
import { t, type BotLanguage } from "./i18n";
import type { ThreadWorkspace } from "./workspaces";

export interface SavedAttachment {
  originalName: string;
  path: string;
  contentType?: string;
  isImage: boolean;
  size: number;
}

export interface FailedAttachment {
  originalName: string;
  reason: string;
}

export interface AttachmentSaveOptions {
  timeoutMs?: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  usedBytes?: number;
}

export interface AttachmentSaveResult {
  saved: SavedAttachment[];
  failed: FailedAttachment[];
  usedBytes: number;
}

export async function saveDiscordAttachments(
  attachments: Iterable<Attachment>,
  workspace: ThreadWorkspace,
  messageId: string,
  options?: AttachmentSaveOptions
): Promise<AttachmentSaveResult> {
  const saved: SavedAttachment[] = [];
  const failed: FailedAttachment[] = [];
  let usedBytes = options?.usedBytes ?? 0;
  const targetDir = path.join(workspace.attachmentsDir, messageId);
  await mkdir(targetDir, { recursive: true });

  for (const attachment of attachments) {
    const originalName = attachment.name ?? attachment.id;
    const declaredSize = typeof attachment.size === "number" ? attachment.size : 0;
    if (options && declaredSize > options.maxFileBytes) {
      failed.push({
        originalName,
        reason: `File is larger than the ${formatBytes(options.maxFileBytes)} limit.`
      });
      continue;
    }
    if (options && usedBytes + declaredSize > options.maxTotalBytes) {
      failed.push({
        originalName,
        reason: `Attachments exceed the ${formatBytes(options.maxTotalBytes)} total limit.`
      });
      continue;
    }

    const fileName = `${attachment.id}-${sanitizeFileName(originalName)}`;
    const targetPath = path.join(targetDir, fileName);
    try {
      const response = await fetchWithTimeout(attachment.url, options?.timeoutMs);
      if (!response.ok) {
        failed.push({ originalName, reason: `Download failed with HTTP ${response.status}.` });
        continue;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (options && bytes.length > options.maxFileBytes) {
        failed.push({
          originalName,
          reason: `File is larger than the ${formatBytes(options.maxFileBytes)} limit.`
        });
        continue;
      }
      if (options && usedBytes + bytes.length > options.maxTotalBytes) {
        failed.push({
          originalName,
          reason: `Attachments exceed the ${formatBytes(options.maxTotalBytes)} total limit.`
        });
        continue;
      }

      await writeFile(targetPath, bytes);
      usedBytes += bytes.length;

      const contentType = attachment.contentType ?? response.headers.get("content-type") ?? undefined;
      saved.push({
        originalName,
        path: targetPath,
        contentType,
        isImage: isImageAttachment(contentType, targetPath),
        size: bytes.length
      });
    } catch (error) {
      failed.push({
        originalName,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { saved, failed, usedBytes };
}

export function formatAttachmentPrompt(
  attachments: SavedAttachment[],
  failed: FailedAttachment[] = [],
  language: BotLanguage = "en"
): string {
  if (attachments.length === 0 && failed.length === 0) {
    return "";
  }

  const messages = t(language);
  const lines = attachments.map((attachment) => {
    const kind = attachment.isImage ? messages.attachmentKindImage : messages.attachmentKindFile;
    return `- ${attachment.originalName} (${kind}, ${formatBytes(attachment.size)}): ${attachment.path}`;
  });
  const failedLines = failed.map((attachment) =>
    `- ${attachment.originalName} (${messages.attachmentKindFailed}): ${attachment.reason}`
  );

  return `\n\n${messages.attachmentPromptIntro}\n${[...lines, ...failedLines].join("\n")}\n`;
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

function fetchWithTimeout(url: string, timeoutMs: number | undefined): Promise<Response> {
  if (!timeoutMs) {
    return fetch(url);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
