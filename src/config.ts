import path from "node:path";

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  discordParentChannelId: string;
  baseWorkspaceDir: string;
  codexBin: string;
  codexModel: string;
  codexReasoningEffort: string;
}

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = Bun.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function loadConfig(): AppConfig {
  return {
    discordToken: requiredEnv("DISCORD_TOKEN"),
    discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
    discordGuildId: requiredEnv("DISCORD_GUILD_ID"),
    discordParentChannelId: requiredEnv("DISCORD_PARENT_CHANNEL_ID"),
    baseWorkspaceDir: path.resolve(optionalEnv("BASE_WORKSPACE_DIR", "./workspaces")),
    codexBin: optionalEnv("CODEX_BIN", "codex"),
    codexModel: optionalEnv("CODEX_MODEL", "gpt-5.5"),
    codexReasoningEffort: optionalEnv("CODEX_REASONING_EFFORT", "high")
  };
}
