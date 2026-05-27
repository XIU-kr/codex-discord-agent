#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="${REPO_DIR}"
CLI_BIN="/usr/local/bin/codex-discord-agent"
GLOBAL_INSTALL_STATE="/etc/codex-discord-agent/install.env"

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

usage() {
  cat <<USAGE
Usage: scripts/install-cli.sh [--install-dir DIR] [--bin PATH]

Installs the codex-discord-agent command shim.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      continue
      ;;
    --bin)
      CLI_BIN="${2:-}"
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
done

if [[ -z "${INSTALL_DIR}" || ! -d "${INSTALL_DIR}" ]]; then
  echo "Install directory not found: ${INSTALL_DIR}" >&2
  exit 1
fi

as_root install -m 0755 "${INSTALL_DIR}/bin/codex-discord-agent" "${CLI_BIN}"
as_root install -d -m 0755 "$(dirname "${GLOBAL_INSTALL_STATE}")"

TMP_STATE="$(mktemp)"
trap 'rm -f "${TMP_STATE}"' EXIT

cat > "${TMP_STATE}" <<EOF
CODEX_DISCORD_AGENT_INSTALL_DIR=${INSTALL_DIR}
EOF

as_root install -m 0644 "${TMP_STATE}" "${GLOBAL_INSTALL_STATE}"

echo "Installed ${CLI_BIN}"
