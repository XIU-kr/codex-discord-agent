import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type ThreadChannel
} from "discord.js";
import { runCodex } from "./codex";
import { loadConfig } from "./config";
import { formatError, splitDiscordMessage } from "./discordFormat";
import { ensureThreadWorkspace, loadSessionId, saveSessionId } from "./workspaces";

const config = loadConfig();
const threadQueues = new Map<string, Promise<void>>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Watching guild ${config.discordGuildId}, parent channel ${config.discordParentChannelId}`);
});

client.on(Events.ThreadCreate, async (thread) => {
  if (!isManagedThread(thread)) {
    return;
  }

  try {
    await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    console.log(`Prepared workspace for thread ${thread.id}`);
  } catch (error) {
    console.error(`Failed to prepare workspace for thread ${thread.id}`, error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!shouldHandleMessage(message)) {
    return;
  }

  const thread = message.channel as ThreadChannel;
  const prompt = message.cleanContent.trim();
  if (!prompt) {
    return;
  }

  enqueueThreadJob(thread.id, async () => {
    await handleThreadPrompt(thread, prompt);
  });
});

await client.login(config.discordToken);

function shouldHandleMessage(message: Message): boolean {
  if (message.author.bot) {
    return false;
  }

  if (!message.guild || message.guild.id !== config.discordGuildId) {
    return false;
  }

  if (!message.channel.isThread()) {
    return false;
  }

  return isManagedThread(message.channel);
}

function isManagedThread(thread: ThreadChannel): boolean {
  return (
    thread.guildId === config.discordGuildId &&
    thread.parentId === config.discordParentChannelId &&
    [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread
    ].includes(thread.type)
  );
}

function enqueueThreadJob(threadId: string, job: () => Promise<void>): void {
  const previous = threadQueues.get(threadId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(job)
    .finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId);
      }
    });

  threadQueues.set(threadId, next);
}

async function handleThreadPrompt(thread: ThreadChannel, prompt: string): Promise<void> {
  const stopTyping = startTyping(thread);

  try {
    const workspace = await ensureThreadWorkspace(config.baseWorkspaceDir, thread.guildId, thread.id);
    const sessionId = await loadSessionId(workspace);
    const result = await runCodex({
      codexBin: config.codexBin,
      model: config.codexModel,
      reasoningEffort: config.codexReasoningEffort,
      prompt,
      workspaceDir: workspace.dir,
      sessionId
    });

    if (result.sessionId) {
      await saveSessionId(workspace, result.sessionId);
    }

    await sendFormatted(thread, result.content);
  } catch (error) {
    console.error(`Codex failed for thread ${thread.id}`, error);
    await sendFormatted(thread, formatError(error));
  } finally {
    stopTyping();
  }
}

function startTyping(thread: ThreadChannel): () => void {
  void thread.sendTyping().catch(() => undefined);

  const timer = setInterval(() => {
    void thread.sendTyping().catch(() => undefined);
  }, 8_000);

  return () => clearInterval(timer);
}

async function sendFormatted(thread: ThreadChannel, content: string): Promise<void> {
  for (const chunk of splitDiscordMessage(content)) {
    await thread.send({
      content: chunk,
      allowedMentions: { parse: [] }
    });
  }
}
