#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="codex-discord-agent.service"
UPDATE_SERVICE_NAME="codex-discord-agent-update.service"
UPDATE_TIMER_NAME="codex-discord-agent-update.timer"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
UNIT_TEMPLATE="${REPO_DIR}/deploy/${SERVICE_NAME}.in"
UNIT_TARGET="/etc/systemd/system/${SERVICE_NAME}"
UPDATE_SERVICE_TEMPLATE="${REPO_DIR}/deploy/${UPDATE_SERVICE_NAME}.in"
UPDATE_TIMER_TEMPLATE="${REPO_DIR}/deploy/${UPDATE_TIMER_NAME}.in"
UPDATE_SERVICE_TARGET="/etc/systemd/system/${UPDATE_SERVICE_NAME}"
UPDATE_TIMER_TARGET="/etc/systemd/system/${UPDATE_TIMER_NAME}"
SERVICE_USER="${SUDO_USER:-$(id -un)}"
BUN_BIN=""
AUTO_UPDATE="keep"
INSTALL_CLI="1"

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

usage() {
  cat <<USAGE
Usage: scripts/install-systemd-service.sh [--start|--restart|--no-start] [--user USER] [--bun-bin PATH] [--enable-auto-update|--disable-auto-update] [--no-cli]

Installs and enables ${SERVICE_NAME}.

Options:
  --start     Start the service after installation.
  --restart   Restart the service after installation.
  --no-start  Install and enable only. This is the default.
  --user      Run the service as USER. Defaults to the invoking user.
  --bun-bin   Full path to Bun. Defaults to auto-detection.
  --enable-auto-update   Install and enable the daily update timer.
  --disable-auto-update  Disable the update timer.
  --no-cli    Do not install the codex-discord-agent command.
USAGE
}

ACTION="no-start"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --start) ACTION="start" ;;
    --restart) ACTION="restart" ;;
    --no-start) ACTION="no-start" ;;
    --enable-auto-update) AUTO_UPDATE="enable" ;;
    --disable-auto-update) AUTO_UPDATE="disable" ;;
    --no-cli) INSTALL_CLI="0" ;;
    --user)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "Missing value for --user." >&2
        exit 2
      fi
      SERVICE_USER="${2:-}"
      shift 2
      continue
      ;;
    --bun-bin)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "Missing value for --bun-bin." >&2
        exit 2
      fi
      BUN_BIN="${2:-}"
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

if [[ -z "${SERVICE_USER}" ]]; then
  echo "Could not determine service user. Pass --user USER." >&2
  exit 1
fi

SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
SERVICE_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"

if [[ -z "${SERVICE_HOME}" ]]; then
  echo "Could not determine home directory for user ${SERVICE_USER}." >&2
  exit 1
fi

if [[ ! -f "${REPO_DIR}/.env" ]]; then
  echo "Missing ${REPO_DIR}/.env. Copy .env.example and fill it before starting the service." >&2
  exit 1
fi

if [[ -z "${BUN_BIN}" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [[ -x "${SERVICE_HOME}/.bun/bin/bun" ]]; then
    BUN_BIN="${SERVICE_HOME}/.bun/bin/bun"
  fi
fi

if [[ -z "${BUN_BIN}" || ! -x "${BUN_BIN}" ]]; then
  echo "Could not find Bun. Install Bun or pass --bun-bin /path/to/bun." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1 && [[ ! -x "${SERVICE_HOME}/.local/bin/codex" ]]; then
  echo "Warning: codex was not found in the current PATH or ${SERVICE_HOME}/.local/bin/codex." >&2
fi

SERVICE_PATH="$(dirname "${BUN_BIN}"):${SERVICE_HOME}/.local/bin:${SERVICE_HOME}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
TMP_UNIT="$(mktemp)"
TMP_UPDATE_SERVICE="$(mktemp)"
TMP_UPDATE_TIMER="$(mktemp)"
trap 'rm -f "${TMP_UNIT}" "${TMP_UPDATE_SERVICE}" "${TMP_UPDATE_TIMER}"' EXIT

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[#&\]/\\&/g'
}

sed \
  -e "s#__REPO_DIR__#$(escape_sed_replacement "${REPO_DIR}")#g" \
  -e "s#__SERVICE_USER__#$(escape_sed_replacement "${SERVICE_USER}")#g" \
  -e "s#__SERVICE_GROUP__#$(escape_sed_replacement "${SERVICE_GROUP}")#g" \
  -e "s#__SERVICE_PATH__#$(escape_sed_replacement "${SERVICE_PATH}")#g" \
  -e "s#__BUN_BIN__#$(escape_sed_replacement "${BUN_BIN}")#g" \
  "${UNIT_TEMPLATE}" > "${TMP_UNIT}"

as_root install -m 0644 "${TMP_UNIT}" "${UNIT_TARGET}"

if [[ "${AUTO_UPDATE}" == "enable" ]]; then
  sed \
    -e "s#__REPO_DIR__#$(escape_sed_replacement "${REPO_DIR}")#g" \
    -e "s#__SERVICE_USER__#$(escape_sed_replacement "${SERVICE_USER}")#g" \
    -e "s#__SERVICE_PATH__#$(escape_sed_replacement "${SERVICE_PATH}")#g" \
    -e "s#__BUN_BIN__#$(escape_sed_replacement "${BUN_BIN}")#g" \
    "${UPDATE_SERVICE_TEMPLATE}" > "${TMP_UPDATE_SERVICE}"

  sed \
    -e "s#__REPO_DIR__#$(escape_sed_replacement "${REPO_DIR}")#g" \
    "${UPDATE_TIMER_TEMPLATE}" > "${TMP_UPDATE_TIMER}"

  as_root install -m 0644 "${TMP_UPDATE_SERVICE}" "${UPDATE_SERVICE_TARGET}"
  as_root install -m 0644 "${TMP_UPDATE_TIMER}" "${UPDATE_TIMER_TARGET}"
elif [[ "${AUTO_UPDATE}" == "disable" ]]; then
  as_root systemctl disable --now "${UPDATE_TIMER_NAME}" >/dev/null 2>&1 || true
fi

as_root systemctl daemon-reload
as_root systemctl enable "${SERVICE_NAME}"

if [[ "${AUTO_UPDATE}" == "enable" ]]; then
  as_root systemctl enable --now "${UPDATE_TIMER_NAME}"
fi

if [[ "${INSTALL_CLI}" == "1" && -x "${REPO_DIR}/scripts/install-cli.sh" ]]; then
  "${REPO_DIR}/scripts/install-cli.sh" --install-dir "${REPO_DIR}"
fi

case "${ACTION}" in
  start)
    as_root systemctl start "${SERVICE_NAME}"
    ;;
  restart)
    as_root systemctl restart "${SERVICE_NAME}"
    ;;
  no-start)
    ;;
esac

as_root systemctl --no-pager --full status "${SERVICE_NAME}" || true
