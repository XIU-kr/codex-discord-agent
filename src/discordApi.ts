import {
  type InteractionReplyOptions,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  MessageFlags,
  type RepliableInteraction,
  type ThreadChannel
} from "discord.js";

export interface DiscordApiOptions {
  timeoutMs?: number;
  retries?: number;
}

export interface DiscordLogContext {
  threadId?: string;
  jobId?: string;
  phase?: string;
  action: string;
}

const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 750;

export async function sendThreadMessage(
  thread: ThreadChannel,
  options: string | MessageCreateOptions,
  apiOptions: DiscordApiOptions = {},
  context: DiscordLogContext = { action: "thread.send" }
): Promise<Message> {
  return withDiscordRetry(
    () => typeof options === "string" ? thread.send(options) : thread.send(options),
    apiOptions,
    { ...context, threadId: context.threadId ?? thread.id }
  );
}

export async function editDiscordMessage(
  message: Message,
  options: string | MessageEditOptions,
  apiOptions: DiscordApiOptions = {},
  context: DiscordLogContext = { action: "message.edit" }
): Promise<Message> {
  return withDiscordRetry(
    () => typeof options === "string" ? message.edit(options) : message.edit(options),
    apiOptions,
    { ...context, threadId: context.threadId ?? message.channelId }
  );
}

export async function sendThreadTyping(
  thread: ThreadChannel,
  apiOptions: DiscordApiOptions = {},
  context: DiscordLogContext = { action: "thread.sendTyping" }
): Promise<void> {
  await withDiscordRetry(
    () => thread.sendTyping(),
    { retries: 0, timeoutMs: apiOptions.timeoutMs },
    { ...context, threadId: context.threadId ?? thread.id }
  ).catch(() => undefined);
}

export async function replyToInteraction(
  interaction: RepliableInteraction,
  options: string | InteractionReplyOptions,
  apiOptions: DiscordApiOptions = {},
  context: DiscordLogContext = { action: "interaction.reply" }
): Promise<void> {
  await withDiscordRetry(
    async () => {
      const replyOptions = normalizeInteractionReplyOptions(options);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(replyOptions);
      } else {
        await interaction.reply(replyOptions);
      }
    },
    apiOptions,
    context
  );
}

function normalizeInteractionReplyOptions(options: string | InteractionReplyOptions): InteractionReplyOptions {
  if (typeof options === "string") {
    return { content: options, flags: MessageFlags.Ephemeral };
  }

  const normalized: InteractionReplyOptions = { ...options };
  const ephemeral = normalized.ephemeral;
  delete normalized.ephemeral;
  if (ephemeral && normalized.flags === undefined) {
    normalized.flags = MessageFlags.Ephemeral;
  }
  return normalized;
}

async function withDiscordRetry<T>(
  operation: () => Promise<T>,
  options: DiscordApiOptions,
  context: DiscordLogContext
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withOptionalTimeout(operation(), options.timeoutMs, "Discord API operation timed out.");
    } catch (error) {
      lastError = error;
      console.warn("Discord API operation failed", {
        ...context,
        attempt: attempt + 1,
        attempts: retries + 1,
        error: error instanceof Error ? error.message : String(error)
      });
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function withOptionalTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (!timeoutMs) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
