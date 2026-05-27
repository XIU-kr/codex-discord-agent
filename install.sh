#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_DISCORD_AGENT_REPO:-XIU-kr/codex-discord-agent}"
VERSION="${CODEX_DISCORD_AGENT_VERSION:-latest}"
INSTALL_DIR="${CODEX_DISCORD_AGENT_INSTALL_DIR:-${HOME}/.local/share/codex-discord-agent}"
SERVICE_USER="${CODEX_DISCORD_AGENT_USER:-$(id -un)}"
START_SERVICE="${CODEX_DISCORD_AGENT_START:-0}"
ENABLE_AUTO_UPDATE="${CODEX_DISCORD_AGENT_AUTO_UPDATE:-1}"
BUN_BIN="${CODEX_DISCORD_AGENT_BUN_BIN:-}"
INSTALL_MARKER=".codex-discord-agent-install"
CLI_BIN="${CODEX_DISCORD_AGENT_CLI_BIN:-/usr/local/bin/codex-discord-agent}"

usage() {
  cat <<USAGE
Usage: install.sh

Environment variables:
  CODEX_DISCORD_AGENT_REPO          GitHub repo, default: ${REPO}
  CODEX_DISCORD_AGENT_VERSION       Release tag or "latest", default: ${VERSION}
  CODEX_DISCORD_AGENT_INSTALL_DIR   Install path, default: ${INSTALL_DIR}
  CODEX_DISCORD_AGENT_USER          systemd service user, default: ${SERVICE_USER}
  CODEX_DISCORD_AGENT_START         Start after install, default: ${START_SERVICE}
  CODEX_DISCORD_AGENT_AUTO_UPDATE   Enable update timer, default: ${ENABLE_AUTO_UPDATE}
  CODEX_DISCORD_AGENT_BUN_BIN       Full Bun path, default: auto-detect
  CODEX_DISCORD_AGENT_CLI_BIN       CLI path, default: ${CLI_BIN}
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_root_privileges() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "This installer needs root privileges for system packages, systemd, and the CLI command." >&2
    echo "Install sudo or rerun as root." >&2
    exit 1
  fi

  echo "Root privileges are required for dependency and systemd setup."
  echo "sudo may ask for your password now."
  sudo -v
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
    echo "Missing required packages: ${packages[*]}" >&2
    echo "Install them with your system package manager and rerun this installer." >&2
    exit 1
  fi
}

ensure_system_dependencies() {
  local missing=()

  for command_name in curl tar unzip; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      missing+=("${command_name}")
    fi
  done

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is required, but systemctl was not found." >&2
    echo "Install this bot on a Linux system with systemd enabled." >&2
    exit 1
  fi

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "Installing missing system packages: ${missing[*]}"
    install_system_packages "${missing[@]}"
  fi
}

ensure_bun() {
  if [[ -n "${BUN_BIN}" && -x "${BUN_BIN}" ]]; then
    return
  fi

  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
    return
  fi

  if [[ -x "${HOME}/.bun/bin/bun" ]]; then
    BUN_BIN="${HOME}/.bun/bin/bun"
    return
  fi

  ensure_system_dependencies
  curl -fsSL https://bun.sh/install | bash
  BUN_BIN="${HOME}/.bun/bin/bun"
}

latest_tag() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
    sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

resolve_version() {
  if [[ "${VERSION}" == "latest" ]]; then
    local tag
    tag="$(latest_tag)"
    if [[ -z "${tag}" ]]; then
      echo "Could not resolve latest release for ${REPO}." >&2
      exit 1
    fi
    printf '%s\n' "${tag}"
  else
    printf '%s\n' "${VERSION}"
  fi
}

download_release() {
  local tag="$1"
  local dest="$2"
  curl -fL "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "${dest}"
}

is_codex_discord_agent_dir() {
  [[ -f "${INSTALL_DIR}/${INSTALL_MARKER}" ]] ||
    grep -q '"name":[[:space:]]*"codex-discord-agent"' "${INSTALL_DIR}/package.json" 2>/dev/null
}

refuse_unknown_nonempty_dir() {
  if [[ ! -d "${INSTALL_DIR}" ]]; then
    return
  fi

  if is_codex_discord_agent_dir; then
    return
  fi

  if find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 | read -r; then
    echo "Refusing to install into non-empty directory that does not look like codex-discord-agent:" >&2
    echo "  ${INSTALL_DIR}" >&2
    echo "Choose an empty directory or set CODEX_DISCORD_AGENT_INSTALL_DIR." >&2
    exit 1
  fi
}

require_root_privileges
ensure_system_dependencies
ensure_bun

TAG="$(resolve_version)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE="${TMP_DIR}/release.tar.gz"
EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"

download_release "${TAG}" "${ARCHIVE}"
tar -xzf "${ARCHIVE}" -C "${EXTRACT_DIR}" --strip-components=1

refuse_unknown_nonempty_dir
mkdir -p "${INSTALL_DIR}"
if [[ -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/.env" "${TMP_DIR}/.env"
fi
if [[ -f "${INSTALL_DIR}/.install.env" ]]; then
  cp "${INSTALL_DIR}/.install.env" "${TMP_DIR}/.install.env"
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
elif [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
fi

cat > "${INSTALL_DIR}/.install.env" <<EOF
CODEX_DISCORD_AGENT_REPO=${REPO}
CODEX_DISCORD_AGENT_VERSION=${VERSION}
CODEX_DISCORD_AGENT_INSTALLED_TAG=${TAG}
CODEX_DISCORD_AGENT_INSTALL_DIR=${INSTALL_DIR}
CODEX_DISCORD_AGENT_SERVICE_USER=${SERVICE_USER}
CODEX_DISCORD_AGENT_BUN_BIN=${BUN_BIN}
CODEX_DISCORD_AGENT_AUTO_UPDATE=${ENABLE_AUTO_UPDATE}
EOF

touch "${INSTALL_DIR}/${INSTALL_MARKER}"

cd "${INSTALL_DIR}"
"${BUN_BIN}" install --production --frozen-lockfile

SYSTEMD_ARGS=(--user "${SERVICE_USER}" --bun-bin "${BUN_BIN}")
if [[ "${ENABLE_AUTO_UPDATE}" == "1" || "${ENABLE_AUTO_UPDATE}" == "true" ]]; then
  SYSTEMD_ARGS+=(--enable-auto-update)
else
  SYSTEMD_ARGS+=(--disable-auto-update)
fi

if [[ "${START_SERVICE}" == "1" || "${START_SERVICE}" == "true" ]]; then
  SYSTEMD_ARGS+=(--restart)
else
  SYSTEMD_ARGS+=(--no-start)
fi

scripts/install-systemd-service.sh "${SYSTEMD_ARGS[@]}"
scripts/install-cli.sh --install-dir "${INSTALL_DIR}" --bin "${CLI_BIN}"

cat <<DONE

codex-discord-agent ${TAG} installed at:
  ${INSTALL_DIR}

Next steps:
  1. Edit ${INSTALL_DIR}/.env
  2. Start the service:
     sudo systemctl restart codex-discord-agent

Logs:
  sudo journalctl -u codex-discord-agent -f

CLI:
  codex-discord-agent status
  codex-discord-agent restart
  codex-discord-agent update
DONE
