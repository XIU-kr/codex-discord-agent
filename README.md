# codex-discord-agent

Discord thread 하나를 Codex 세션 하나와 독립 workspace 하나에 연결하는 TypeScript 봇입니다.

## 동작 방식

- 지정한 Discord 서버와 부모 채널만 감시합니다.
- 해당 채널에서 thread가 만들어지면 `BASE_WORKSPACE_DIR/<guildId>/<threadId>` workspace를 준비합니다.
- thread에 사용자가 메시지를 쓰면 Codex CLI를 실행합니다.
- 첫 요청은 새 Codex 세션으로 시작하고, 이후 같은 thread의 요청은 저장된 session id로 이어갑니다.
- Codex가 응답하는 동안 Discord의 typing indicator를 주기적으로 표시합니다.
- 응답은 Discord 메시지 길이 제한에 맞춰 나뉘며 Markdown/code block을 최대한 보존합니다.

## 요구 사항

- Bun
- Codex CLI 로그인 완료 상태
- Discord bot token
- Discord Developer Portal에서 Message Content Intent 활성화

## 한 줄 설치

GitHub 릴리즈 tarball을 내려받아 설치하므로 `git clone`이 필요 없습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/XIU-kr/codex-discord-agent/main/install.sh | bash
```

설치 위치 기본값은 `~/.local/share/codex-discord-agent`입니다. 설치 후 `.env`를 채우고 서비스를 시작합니다.

```bash
nano ~/.local/share/codex-discord-agent/.env
sudo systemctl restart codex-discord-agent
```

설치 옵션은 환경변수로 지정합니다.

```bash
CODEX_DISCORD_AGENT_INSTALL_DIR=/opt/codex-discord-agent \
CODEX_DISCORD_AGENT_USER=codex \
CODEX_DISCORD_AGENT_START=1 \
curl -fsSL https://raw.githubusercontent.com/XIU-kr/codex-discord-agent/main/install.sh | bash
```

## 설정

```bash
cp .env.example .env
```

`.env`에 값을 채웁니다.

```bash
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
DISCORD_PARENT_CHANNEL_ID=...
BASE_WORKSPACE_DIR=./workspaces
CODEX_BIN=codex
CODEX_MODEL=gpt-5.5
CODEX_REASONING_EFFORT=high
```

## 설치와 실행

```bash
bun install
bun run typecheck
bun test
bun run start
```

## systemd 서비스

백그라운드 상시 실행은 systemd 서비스로 등록합니다.

```bash
scripts/install-systemd-service.sh --start
```

설치 스크립트는 레포 경로, 실행 사용자, Bun 위치를 자동으로 감지해서 `/etc/systemd/system/codex-discord-agent.service`를 생성합니다. 자동 업데이트 timer도 같이 켤 수 있습니다.

```bash
scripts/install-systemd-service.sh --user ubuntu --bun-bin /home/ubuntu/.bun/bin/bun --enable-auto-update --start
```

등록만 하고 아직 시작하지 않으려면:

```bash
scripts/install-systemd-service.sh --no-start
```

상태 확인:

```bash
sudo systemctl status codex-discord-agent
```

로그 확인:

```bash
sudo journalctl -u codex-discord-agent -f
```

재시작과 중지:

```bash
sudo systemctl restart codex-discord-agent
sudo systemctl stop codex-discord-agent
```

서비스 템플릿은 `deploy/codex-discord-agent.service.in`에 있으며, 설치된 서비스는 현재 레포의 `.env`를 읽습니다.

## 업데이트

설치된 버전과 최신 GitHub Release를 확인합니다.

```bash
scripts/update.sh --check
```

업데이트를 적용합니다.

```bash
scripts/update.sh --apply
```

한 줄 설치를 사용하면 daily systemd timer가 기본으로 등록됩니다.

```bash
sudo systemctl status codex-discord-agent-update.timer
sudo systemctl list-timers codex-discord-agent-update.timer
```

자동 업데이트를 끄거나 다시 켤 수 있습니다.

```bash
scripts/install-systemd-service.sh --disable-auto-update
scripts/install-systemd-service.sh --enable-auto-update
```

## Discord 권한

봇에는 최소한 다음 권한이 필요합니다.

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Use Public Threads
- Use Private Threads

봇 초대 URL은 Discord Developer Portal의 OAuth2 URL Generator에서 `bot` scope와 위 권한을 선택해 생성합니다.

## Codex 실행 기본값

첫 요청:

```bash
codex exec --json --skip-git-repo-check -s danger-full-access -a never -m gpt-5.5 -c 'model_reasoning_effort="high"' -C <workspace> -
```

후속 요청:

```bash
codex exec resume --json -m gpt-5.5 -c 'model_reasoning_effort="high"' <sessionId> -
```

`danger-full-access`와 approval `never`는 강한 권한입니다. 신뢰하는 서버와 채널에서만 실행하세요.
