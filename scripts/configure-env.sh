#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${INSTALL_DIR}/.env"
FORCE="0"

usage() {
  cat <<USAGE
Usage: scripts/configure-env.sh [--force]

Creates or updates .env using interactive prompts. Existing .env files are kept
unless --force is used or the user chooses to reconfigure.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE="1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

tty_read() {
  local prompt="$1"
  local default="${2:-}"
  local value

  if [[ -n "${default}" ]]; then
    printf '%s [%s]: ' "${prompt}" "${default}" > /dev/tty
  else
    printf '%s: ' "${prompt}" > /dev/tty
  fi

  IFS= read -r value < /dev/tty
  printf '%s\n' "${value:-${default}}"
}

tty_read_secret() {
  local prompt="$1"
  local default="${2:-}"
  local value

  if [[ -n "${default}" ]]; then
    printf '%s [keep existing]: ' "${prompt}" > /dev/tty
  else
    printf '%s: ' "${prompt}" > /dev/tty
  fi

  stty -echo < /dev/tty
  IFS= read -r value < /dev/tty || {
    stty echo < /dev/tty
    return 1
  }
  stty echo < /dev/tty
  printf '\n' > /dev/tty
  printf '%s\n' "${value:-${default}}"
}

env_get() {
  local key="$1"
  local value=""
  if [[ -f "${ENV_FILE}" ]]; then
    value="$(sed -n "s/^${key}=//p" "${ENV_FILE}" | tail -n 1)"
  fi
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s\n' "${value}"
}

escape_env_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

require_tty() {
  if [[ ! -r /dev/tty ]]; then
    echo "Interactive configuration requires a TTY." >&2
    echo "Create ${ENV_FILE} manually or run this script from an interactive shell." >&2
    exit 1
  fi
}

if [[ -f "${ENV_FILE}" && "${FORCE}" != "1" ]]; then
  require_tty
  answer="$(tty_read "Existing .env found. Reconfigure it? (y/N)" "N")"
  case "${answer}" in
    y|Y|yes|YES) ;;
    *)
      echo "Keeping existing ${ENV_FILE}."
      exit 0
      ;;
  esac
fi

require_tty

echo "Configure codex-discord-agent." > /dev/tty
echo "Press Enter to accept defaults where shown." > /dev/tty

DISCORD_TOKEN_VALUE="${DISCORD_TOKEN:-$(env_get DISCORD_TOKEN)}"
DISCORD_CLIENT_ID_VALUE="${DISCORD_CLIENT_ID:-$(env_get DISCORD_CLIENT_ID)}"
DISCORD_GUILD_ID_VALUE="${DISCORD_GUILD_ID:-$(env_get DISCORD_GUILD_ID)}"
DISCORD_PARENT_CHANNEL_ID_VALUE="${DISCORD_PARENT_CHANNEL_ID:-$(env_get DISCORD_PARENT_CHANNEL_ID)}"
BASE_WORKSPACE_DIR_VALUE="${BASE_WORKSPACE_DIR:-$(env_get BASE_WORKSPACE_DIR)}"
CODEX_BIN_VALUE="${CODEX_BIN:-$(env_get CODEX_BIN)}"
CODEX_MODEL_VALUE="${CODEX_MODEL:-$(env_get CODEX_MODEL)}"
CODEX_REASONING_EFFORT_VALUE="${CODEX_REASONING_EFFORT:-$(env_get CODEX_REASONING_EFFORT)}"
CODEX_RUN_TIMEOUT_SECONDS_VALUE="${CODEX_RUN_TIMEOUT_SECONDS:-$(env_get CODEX_RUN_TIMEOUT_SECONDS)}"
CODEX_IDLE_TIMEOUT_SECONDS_VALUE="${CODEX_IDLE_TIMEOUT_SECONDS:-$(env_get CODEX_IDLE_TIMEOUT_SECONDS)}"
DISCORD_SEND_TIMEOUT_SECONDS_VALUE="${DISCORD_SEND_TIMEOUT_SECONDS:-$(env_get DISCORD_SEND_TIMEOUT_SECONDS)}"
BOT_LANGUAGE_VALUE="${BOT_LANGUAGE:-$(env_get BOT_LANGUAGE)}"
DISCORD_ALLOWED_USER_IDS_VALUE="${DISCORD_ALLOWED_USER_IDS:-$(env_get DISCORD_ALLOWED_USER_IDS)}"
DISCORD_ALLOWED_ROLE_IDS_VALUE="${DISCORD_ALLOWED_ROLE_IDS:-$(env_get DISCORD_ALLOWED_ROLE_IDS)}"
STALE_WORKSPACE_DAYS_VALUE="${STALE_WORKSPACE_DAYS:-$(env_get STALE_WORKSPACE_DAYS)}"

DISCORD_TOKEN_VALUE="$(tty_read_secret "Discord bot token" "${DISCORD_TOKEN_VALUE}")"
DISCORD_CLIENT_ID_VALUE="$(tty_read "Discord client/application ID" "${DISCORD_CLIENT_ID_VALUE}")"
DISCORD_GUILD_ID_VALUE="$(tty_read "Discord guild/server ID" "${DISCORD_GUILD_ID_VALUE}")"
DISCORD_PARENT_CHANNEL_ID_VALUE="$(tty_read "Discord parent channel ID" "${DISCORD_PARENT_CHANNEL_ID_VALUE}")"
BASE_WORKSPACE_DIR_VALUE="$(tty_read "Workspace directory" "${BASE_WORKSPACE_DIR_VALUE:-./workspaces}")"
CODEX_BIN_VALUE="$(tty_read "Codex command or full path" "${CODEX_BIN_VALUE:-codex}")"
CODEX_MODEL_VALUE="$(tty_read "Codex model" "${CODEX_MODEL_VALUE:-gpt-5.5}")"
CODEX_REASONING_EFFORT_VALUE="$(tty_read "Codex reasoning effort" "${CODEX_REASONING_EFFORT_VALUE:-high}")"
CODEX_RUN_TIMEOUT_SECONDS_VALUE="$(tty_read "Codex max run time in seconds (0 disables)" "${CODEX_RUN_TIMEOUT_SECONDS_VALUE:-2700}")"
CODEX_IDLE_TIMEOUT_SECONDS_VALUE="$(tty_read "Codex no-output timeout in seconds (0 disables)" "${CODEX_IDLE_TIMEOUT_SECONDS_VALUE:-600}")"
DISCORD_SEND_TIMEOUT_SECONDS_VALUE="$(tty_read "Discord send timeout in seconds (0 disables)" "${DISCORD_SEND_TIMEOUT_SECONDS_VALUE:-30}")"
BOT_LANGUAGE_VALUE="$(tty_read "Bot language (en or ko)" "${BOT_LANGUAGE_VALUE:-en}")"
DISCORD_ALLOWED_USER_IDS_VALUE="$(tty_read "Allowed Discord user IDs, comma-separated (blank for everyone)" "${DISCORD_ALLOWED_USER_IDS_VALUE}")"
DISCORD_ALLOWED_ROLE_IDS_VALUE="$(tty_read "Allowed Discord role IDs, comma-separated (blank for everyone)" "${DISCORD_ALLOWED_ROLE_IDS_VALUE}")"
STALE_WORKSPACE_DAYS_VALUE="$(tty_read "Stale workspace cleanup age in days" "${STALE_WORKSPACE_DAYS_VALUE:-30}")"

if [[ -z "${DISCORD_TOKEN_VALUE}" || -z "${DISCORD_CLIENT_ID_VALUE}" || -z "${DISCORD_GUILD_ID_VALUE}" || -z "${DISCORD_PARENT_CHANNEL_ID_VALUE}" ]]; then
  echo "DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, and DISCORD_PARENT_CHANNEL_ID are required." >&2
  exit 1
fi

case "${BOT_LANGUAGE_VALUE}" in
  en|ko) ;;
  *)
    echo "BOT_LANGUAGE must be en or ko." >&2
    exit 1
    ;;
esac

umask 077
cat > "${ENV_FILE}" <<EOF
DISCORD_TOKEN="$(escape_env_value "${DISCORD_TOKEN_VALUE}")"
DISCORD_CLIENT_ID="$(escape_env_value "${DISCORD_CLIENT_ID_VALUE}")"
DISCORD_GUILD_ID="$(escape_env_value "${DISCORD_GUILD_ID_VALUE}")"
DISCORD_PARENT_CHANNEL_ID="$(escape_env_value "${DISCORD_PARENT_CHANNEL_ID_VALUE}")"

BASE_WORKSPACE_DIR="$(escape_env_value "${BASE_WORKSPACE_DIR_VALUE}")"
CODEX_BIN="$(escape_env_value "${CODEX_BIN_VALUE}")"
CODEX_MODEL="$(escape_env_value "${CODEX_MODEL_VALUE}")"
CODEX_REASONING_EFFORT="$(escape_env_value "${CODEX_REASONING_EFFORT_VALUE}")"
CODEX_RUN_TIMEOUT_SECONDS="$(escape_env_value "${CODEX_RUN_TIMEOUT_SECONDS_VALUE}")"
CODEX_IDLE_TIMEOUT_SECONDS="$(escape_env_value "${CODEX_IDLE_TIMEOUT_SECONDS_VALUE}")"
DISCORD_SEND_TIMEOUT_SECONDS="$(escape_env_value "${DISCORD_SEND_TIMEOUT_SECONDS_VALUE}")"
BOT_LANGUAGE="$(escape_env_value "${BOT_LANGUAGE_VALUE}")"
DISCORD_ALLOWED_USER_IDS="$(escape_env_value "${DISCORD_ALLOWED_USER_IDS_VALUE}")"
DISCORD_ALLOWED_ROLE_IDS="$(escape_env_value "${DISCORD_ALLOWED_ROLE_IDS_VALUE}")"
STALE_WORKSPACE_DAYS="$(escape_env_value "${STALE_WORKSPACE_DAYS_VALUE}")"
EOF
chmod 600 "${ENV_FILE}"

echo "Wrote ${ENV_FILE}."
