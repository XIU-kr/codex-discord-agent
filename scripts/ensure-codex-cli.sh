#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${SUDO_USER:-$(id -un)}"
ENV_FILE=""
CODEX_BIN_ARG=""
INSTALL_CODEX="1"
AUTH_CODEX="1"
CODEX_PACKAGE="${CODEX_DISCORD_AGENT_CODEX_PACKAGE:-@openai/codex}"

usage() {
  cat <<USAGE
Usage: scripts/ensure-codex-cli.sh [--user USER] [--env-file FILE] [--bin COMMAND] [--no-install] [--no-auth]

Checks the Codex CLI for the service user, installs it with npm when missing, and guides login.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      SERVICE_USER="${2:-}"
      shift 2
      continue
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      continue
      ;;
    --bin)
      CODEX_BIN_ARG="${2:-}"
      shift 2
      continue
      ;;
    --no-install)
      INSTALL_CODEX="0"
      ;;
    --no-auth)
      AUTH_CODEX="0"
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

if [[ -z "${SERVICE_USER}" ]]; then
  echo "Could not determine service user. Pass --user USER." >&2
  exit 1
fi

SERVICE_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
if [[ -z "${SERVICE_HOME}" ]]; then
  echo "Could not determine home directory for user ${SERVICE_USER}." >&2
  exit 1
fi

if [[ -n "${ENV_FILE}" && -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

CODEX_BIN="${CODEX_BIN_ARG:-${CODEX_BIN:-codex}}"
SERVICE_PATH="${SERVICE_HOME}/.local/bin:${SERVICE_HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_service_user() {
  local -a env_args=(
    "HOME=${SERVICE_HOME}"
    "PATH=${SERVICE_PATH}"
  )

  if [[ -n "${CODEX_HOME:-}" ]]; then
    env_args+=("CODEX_HOME=${CODEX_HOME}")
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    env_args+=("OPENAI_API_KEY=${OPENAI_API_KEY}")
  fi

  if [[ "$(id -un)" == "${SERVICE_USER}" ]]; then
    env "${env_args[@]}" "$@"
  else
    sudo -H -u "${SERVICE_USER}" env "${env_args[@]}" "$@"
  fi
}

install_system_packages() {
  local packages=("$@")
  if [[ "${#packages[@]}" -eq 0 ]]; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y "${packages[@]}"
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add "${packages[@]}"
  else
    echo "Missing required package: ${packages[*]}" >&2
    echo "Install it with your system package manager and rerun this script." >&2
    exit 1
  fi
}

ensure_npm() {
  if command -v npm >/dev/null 2>&1; then
    return
  fi

  echo "npm is required to install Codex CLI. Installing npm..."
  install_system_packages npm
}

codex_exists() {
  if [[ "${CODEX_BIN}" == */* ]]; then
    run_as_service_user test -x "${CODEX_BIN}"
  else
    run_as_service_user sh -c 'command -v "$1" >/dev/null 2>&1' sh "${CODEX_BIN}"
  fi
}

resolve_codex_bin() {
  if [[ "${CODEX_BIN}" == */* ]]; then
    printf '%s\n' "${CODEX_BIN}"
  else
    run_as_service_user sh -c 'command -v "$1"' sh "${CODEX_BIN}"
  fi
}

install_codex() {
  ensure_npm
  echo "Installing Codex CLI for ${SERVICE_USER} with npm prefix ${SERVICE_HOME}/.local..."
  run_as_service_user mkdir -p "${SERVICE_HOME}/.local"
  run_as_service_user npm install -g --prefix "${SERVICE_HOME}/.local" "${CODEX_PACKAGE}"
}

has_tty() {
  [[ -r /dev/tty && -w /dev/tty ]]
}

prompt_yes_no() {
  local prompt="$1"
  local default="$2"
  local answer

  if ! has_tty; then
    return 1
  fi

  printf '%s ' "${prompt}" > /dev/tty
  read -r answer < /dev/tty || answer=""
  answer="${answer:-${default}}"
  [[ "${answer}" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]
}

run_login() {
  local codex_path="$1"

  if run_as_service_user "${codex_path}" login --device-auth < /dev/tty > /dev/tty; then
    return
  fi

  echo "Device login did not complete. Falling back to regular Codex login..." > /dev/tty
  run_as_service_user "${codex_path}" login < /dev/tty > /dev/tty
}

print_login_instructions() {
  local codex_path="$1"
  cat <<INSTRUCTIONS
Codex is not authenticated for service user ${SERVICE_USER}.
Run one of these commands before starting the service:

  sudo -H -u ${SERVICE_USER} ${codex_path} login --device-auth
  sudo -H -u ${SERVICE_USER} ${codex_path} login

If you use an API key instead, put OPENAI_API_KEY in the service environment.
INSTRUCTIONS
}

echo "Checking Codex CLI for service user ${SERVICE_USER}..."

if ! codex_exists; then
  if [[ "${INSTALL_CODEX}" != "1" ]]; then
    echo "Codex CLI was not found for ${SERVICE_USER}: ${CODEX_BIN}" >&2
    exit 1
  fi

  if [[ "${CODEX_BIN}" == */* ]]; then
    echo "Configured CODEX_BIN is a path and was not found: ${CODEX_BIN}" >&2
    echo "Install Codex there or set CODEX_BIN=codex to use ${SERVICE_HOME}/.local/bin/codex." >&2
    exit 1
  fi

  install_codex
fi

CODEX_PATH="$(resolve_codex_bin)"
echo "Codex CLI found: ${CODEX_PATH}"
run_as_service_user "${CODEX_PATH}" --version >/dev/null

if [[ "${AUTH_CODEX}" != "1" ]]; then
  exit 0
fi

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is configured; skipping interactive Codex login."
  exit 0
fi

if run_as_service_user "${CODEX_PATH}" login status >/dev/null 2>&1; then
  echo "Codex authentication is configured for ${SERVICE_USER}."
  exit 0
fi

if prompt_yes_no "Codex is not authenticated for ${SERVICE_USER}. Run Codex login now? [Y/n]" "Y"; then
  run_login "${CODEX_PATH}"
  if run_as_service_user "${CODEX_PATH}" login status >/dev/null 2>&1; then
    echo "Codex authentication is configured for ${SERVICE_USER}."
  else
    echo "Codex login finished, but login status still failed." >&2
    print_login_instructions "${CODEX_PATH}" >&2
  fi
else
  print_login_instructions "${CODEX_PATH}"
fi
