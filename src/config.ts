import path from "node:path";
import { parseLanguage, type BotLanguage } from "./i18n";

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  discordParentChannelId: string;
  baseWorkspaceDir: string;
  codexBin: string;
  codexModel: string;
  codexReasoningEffort: string;
  allowedUserIds: string[];
  allowedRoleIds: string[];
  staleWorkspaceDays: number;
  language: BotLanguage;
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

function optionalListEnv(name: string): string[] {
  return optionalEnv(name, "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalNumberEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    codexReasoningEffort: optionalEnv("CODEX_REASONING_EFFORT", "high"),
    allowedUserIds: optionalListEnv("DISCORD_ALLOWED_USER_IDS"),
    allowedRoleIds: optionalListEnv("DISCORD_ALLOWED_ROLE_IDS"),
    staleWorkspaceDays: optionalNumberEnv("STALE_WORKSPACE_DAYS", 30),
    language: parseLanguage(optionalEnv("BOT_LANGUAGE", "en"))
  };
}
