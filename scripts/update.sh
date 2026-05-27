#!/usr/bin/env bash
set -euo pipefail

ORIGINAL_UPDATE_SCRIPT="${CODEX_DISCORD_AGENT_UPDATE_SCRIPT:-${BASH_SOURCE[0]}}"

if [[ -z "${CODEX_DISCORD_AGENT_UPDATE_IN_TEMP:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  TMP_SELF="$(mktemp)"
  cp "${BASH_SOURCE[0]}" "${TMP_SELF}"
  chmod +x "${TMP_SELF}"
  export CODEX_DISCORD_AGENT_UPDATE_IN_TEMP=1
  export CODEX_DISCORD_AGENT_UPDATE_SCRIPT="${ORIGINAL_UPDATE_SCRIPT}"
  exec bash "${TMP_SELF}" "$@"
fi

MODE="check"
INSTALL_DIR="${CODEX_DISCORD_AGENT_INSTALL_DIR:-}"
REPO="${CODEX_DISCORD_AGENT_REPO:-XIU-kr/codex-discord-agent}"
VERSION="${CODEX_DISCORD_AGENT_VERSION:-latest}"
SERVICE_USER="${CODEX_DISCORD_AGENT_SERVICE_USER:-}"
BUN_BIN="${CODEX_DISCORD_AGENT_BUN_BIN:-}"
SERVICE_NAME="codex-discord-agent.service"
INSTALL_MARKER=".codex-discord-agent-install"

usage() {
  cat <<USAGE
Usage: scripts/update.sh [--check|--apply|--auto] [--install-dir DIR] [--repo OWNER/REPO] [--version TAG|latest]

Modes:
  --check  Print current/latest version information.
  --apply  Apply an update if one is available.
  --auto   Same as --apply, intended for systemd timer use.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --auto) MODE="auto" ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      continue
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      continue
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      continue
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

if [[ -z "${INSTALL_DIR}" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${ORIGINAL_UPDATE_SCRIPT}")" && pwd)"
  INSTALL_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
fi

INSTALL_STATE="${INSTALL_DIR}/.install.env"
if [[ -f "${INSTALL_STATE}" ]]; then
  # shellcheck disable=SC1090
  source "${INSTALL_STATE}"
  REPO="${CODEX_DISCORD_AGENT_REPO:-${REPO}}"
  VERSION="${CODEX_DISCORD_AGENT_VERSION:-${VERSION}}"
  SERVICE_USER="${CODEX_DISCORD_AGENT_SERVICE_USER:-${SERVICE_USER}}"
  BUN_BIN="${CODEX_DISCORD_AGENT_BUN_BIN:-${BUN_BIN}}"
fi

if [[ -z "${SERVICE_USER}" ]]; then
  SERVICE_USER="$(stat -c '%U' "${INSTALL_DIR}")"
fi

SERVICE_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
if [[ -z "${SERVICE_HOME}" ]]; then
  echo "Could not determine home directory for ${SERVICE_USER}." >&2
  exit 1
fi

current_version() {
  sed -n 's/[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${INSTALL_DIR}/package.json" | head -n 1
}

assert_install_dir() {
  if [[ -f "${INSTALL_DIR}/${INSTALL_MARKER}" ]]; then
    return
  fi

  if grep -q '"name":[[:space:]]*"codex-discord-agent"' "${INSTALL_DIR}/package.json" 2>/dev/null; then
    return
  fi

  echo "Refusing to update directory that does not look like codex-discord-agent:" >&2
  echo "  ${INSTALL_DIR}" >&2
  exit 1
}

latest_tag() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
    sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

resolve_target_tag() {
  if [[ "${VERSION}" == "latest" ]]; then
    latest_tag
  else
    printf '%s\n' "${VERSION}"
  fi
}

version_from_tag() {
  printf '%s\n' "$1" | sed 's/^v//'
}

run_as_service_user() {
  if [[ "$(id -un)" == "${SERVICE_USER}" ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "${SERVICE_USER}" HOME="${SERVICE_HOME}" "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "${SERVICE_USER}" -- "$@"
  else
    echo "Need sudo or runuser to execute commands as ${SERVICE_USER}." >&2
    exit 1
  fi
}

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

TARGET_TAG="$(resolve_target_tag)"
if [[ -z "${TARGET_TAG}" ]]; then
  echo "Could not resolve target release for ${REPO}." >&2
  exit 1
fi

assert_install_dir
CURRENT_VERSION="$(current_version)"
TARGET_VERSION="$(version_from_tag "${TARGET_TAG}")"

echo "Current version: ${CURRENT_VERSION}"
echo "Target version:  ${TARGET_VERSION} (${TARGET_TAG})"

if [[ "${CURRENT_VERSION}" == "${TARGET_VERSION}" ]]; then
  echo "Already up to date."
  exit 0
fi

if [[ "${MODE}" == "check" ]]; then
  echo "Update available."
  exit 0
fi

if [[ -z "${BUN_BIN}" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [[ -x "${SERVICE_HOME}/.bun/bin/bun" ]]; then
    BUN_BIN="${SERVICE_HOME}/.bun/bin/bun"
  else
    echo "Could not find Bun. Set CODEX_DISCORD_AGENT_BUN_BIN." >&2
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE="${TMP_DIR}/release.tar.gz"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"

curl -fL "https://github.com/${REPO}/archive/refs/tags/${TARGET_TAG}.tar.gz" -o "${ARCHIVE}"
tar -xzf "${ARCHIVE}" -C "${EXTRACT_DIR}" --strip-components=1

if [[ -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/.env" "${TMP_DIR}/.env"
fi

find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
  ! -name ".env" \
  ! -name ".install.env" \
  ! -name "${INSTALL_MARKER}" \
  ! -name "workspaces" \
  -exec rm -rf {} +

shopt -s dotglob nullglob
cp -a "${EXTRACT_DIR}/"* "${INSTALL_DIR}/"
shopt -u dotglob nullglob

if [[ -f "${TMP_DIR}/.env" ]]; then
  cp "${TMP_DIR}/.env" "${INSTALL_DIR}/.env"
fi

cat > "${INSTALL_DIR}/.install.env" <<EOF
CODEX_DISCORD_AGENT_REPO=${REPO}
CODEX_DISCORD_AGENT_VERSION=${VERSION}
CODEX_DISCORD_AGENT_INSTALLED_TAG=${TARGET_TAG}
CODEX_DISCORD_AGENT_INSTALL_DIR=${INSTALL_DIR}
CODEX_DISCORD_AGENT_SERVICE_USER=${SERVICE_USER}
CODEX_DISCORD_AGENT_BUN_BIN=${BUN_BIN}
CODEX_DISCORD_AGENT_AUTO_UPDATE=${CODEX_DISCORD_AGENT_AUTO_UPDATE:-1}
EOF

touch "${INSTALL_DIR}/${INSTALL_MARKER}"

run_as_service_user "${BUN_BIN}" install --production --frozen-lockfile
as_root "${INSTALL_DIR}/scripts/install-systemd-service.sh" --user "${SERVICE_USER}" --bun-bin "${BUN_BIN}" --enable-auto-update --restart

echo "Updated codex-discord-agent to ${TARGET_TAG}."
