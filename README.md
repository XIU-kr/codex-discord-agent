# codex-discord-agent

Run Codex from Discord threads. Each managed Discord thread gets its own isolated workspace and Codex session.

## What It Does

- Watches one Discord guild and one parent channel.
- Creates one workspace per thread: `BASE_WORKSPACE_DIR/<guildId>/<threadId>`.
- Sends each user message in the thread to Codex.
- Interrupts the running Codex job when a new user message arrives, lets Codex read it, then resumes the work in the same thread session.
- Shows Discord typing indicators and an editable job status message with recent progress.
- Supports English and Korean bot messages with `BOT_LANGUAGE=en|ko`.
- Supports short Discord commands, Korean aliases, file attachments, image attachments, cancellation, session reset, usage reporting, and stale workspace cleanup.
- Installs as a systemd service with an optional daily auto-update timer.

## Requirements

The one-line installer is designed for Linux servers with systemd.

Required:

- Linux with systemd
- root access or a user with `sudo`
- Discord server admin permissions
- a Discord bot token
- Codex CLI access. The installer checks this, installs the CLI when missing, and guides login for the service user.

The installer checks and installs these system packages when missing:

- `curl`
- `tar`
- `unzip`
- `npm` when Codex CLI must be installed

If you are not root, the installer asks for your `sudo` password at the start. Bun is installed automatically when missing.

Codex must be authenticated before the bot can use it. During installation, the installer checks the service user's Codex login status and can start the login flow. To do it manually:

```bash
codex login --device-auth
codex --version
```

If `codex` is not in the service PATH, set `CODEX_BIN` in `.env` to the full path:

```bash
which codex
```

## Create The Discord Bot

1. Open the Discord Developer Portal:

   https://discord.com/developers/applications

2. Click **New Application** and choose a name.

   Example: `Codex Discord Agent`

3. Open **Bot** in the left sidebar and click **Add Bot**.

4. In the **Token** section, copy or reset the token.

   This value goes into `DISCORD_TOKEN`. Keep it private.

5. In **Bot > Privileged Gateway Intents**, enable:

   - Message Content Intent

6. Copy the application **Client ID**.

   This value goes into `DISCORD_CLIENT_ID`.

7. Open **OAuth2 > URL Generator**.

   Select these scopes:

   - `bot`
   - `applications.commands`

   Select these bot permissions:

   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Manage Messages
   - Create Public Threads
   - Create Private Threads
   - Use Public Threads
   - Use Private Threads

8. Open the generated URL and invite the bot to your server.

9. Enable Discord Developer Mode:

   **User Settings > Advanced > Developer Mode**

10. Copy your server ID.

    Right-click the server name and choose **Copy Server ID**. This is `DISCORD_GUILD_ID`.

11. Copy the parent channel ID.

    Right-click the channel where users will create Codex threads and choose **Copy Channel ID**. This is `DISCORD_PARENT_CHANNEL_ID`.

The bot only responds in threads under the configured parent channel.

## One-Line Install

No `git clone` is required. The installer downloads the latest GitHub release tarball.

```bash
curl -fsSL https://raw.githubusercontent.com/XIU-kr/codex-discord-agent/main/install.sh | bash
```

Default install path:

```text
~/.local/share/codex-discord-agent
```

During installation, the script asks for the required Discord and Codex settings and writes `.env` for you. The Discord token prompt is hidden so it does not echo to your terminal.

After installation, restart the service if you did not start it during install:

```bash
codex-discord-agent restart
```

Install options are configured with environment variables:

```bash
CODEX_DISCORD_AGENT_INSTALL_DIR=/opt/codex-discord-agent \
CODEX_DISCORD_AGENT_USER=codex \
CODEX_DISCORD_AGENT_START=1 \
curl -fsSL https://raw.githubusercontent.com/XIU-kr/codex-discord-agent/main/install.sh | bash
```

## Configuration

Most users should configure the bot through the interactive setup command:

```bash
codex-discord-agent configure
```

For checkout-based development, run:

```bash
scripts/configure-env.sh
```

The generated `.env` is an internal service configuration file. You normally do not need to edit it manually.

Required values:

```bash
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
DISCORD_PARENT_CHANNEL_ID=...
```

Optional values:

```bash
BASE_WORKSPACE_DIR=./workspaces
CODEX_BIN=codex
CODEX_MODEL=gpt-5.5
CODEX_MODEL_CHOICES=
CODEX_REASONING_EFFORT=high
CODEX_RUN_TIMEOUT_SECONDS=2700
CODEX_IDLE_TIMEOUT_SECONDS=600
DISCORD_SEND_TIMEOUT_SECONDS=30
ATTACHMENT_DOWNLOAD_TIMEOUT_SECONDS=60
ATTACHMENT_MAX_FILE_BYTES=26214400
ATTACHMENT_MAX_TOTAL_BYTES=104857600
HIDE_WORKSPACE_PATHS=0
BOT_LANGUAGE=en
DISCORD_ALLOWED_USER_IDS=
DISCORD_ALLOWED_ROLE_IDS=
STALE_WORKSPACE_DAYS=30
```

Configuration reference:

- `DISCORD_TOKEN`: Discord bot token.
- `DISCORD_CLIENT_ID`: Discord application client ID.
- `DISCORD_GUILD_ID`: the only Discord server where the bot runs.
- `DISCORD_PARENT_CHANNEL_ID`: the parent channel whose threads are managed.
- `BASE_WORKSPACE_DIR`: root directory for thread workspaces.
- `CODEX_BIN`: Codex CLI command or full path.
- `CODEX_MODEL`: Codex model. Default: `gpt-5.5`.
- `CODEX_MODEL_CHOICES`: comma-separated model choices shown in Discord thread settings. Empty means only `CODEX_MODEL`.
- `CODEX_REASONING_EFFORT`: reasoning effort. Default: `high`.
- `CODEX_RUN_TIMEOUT_SECONDS`: maximum wall-clock time for one Codex job. Default: `2700`. Set `0` to disable.
- `CODEX_IDLE_TIMEOUT_SECONDS`: maximum time to wait with no Codex output before stopping the job. Default: `600`. Set `0` to disable.
- `DISCORD_SEND_TIMEOUT_SECONDS`: maximum time to wait while sending a Codex response to Discord. Default: `30`. Set `0` to disable.
- `ATTACHMENT_DOWNLOAD_TIMEOUT_SECONDS`: maximum time to wait for each Discord attachment download. Default: `60`. Set `0` to disable.
- `ATTACHMENT_MAX_FILE_BYTES`: maximum downloaded size for one attachment. Default: `26214400`.
- `ATTACHMENT_MAX_TOTAL_BYTES`: maximum downloaded size for all attachments in one job. Default: `104857600`.
- `SHELL_COMMAND_TIMEOUT_SECONDS`: maximum wall-clock time for one Discord shell command. Default: `120`.
- `SHELL_COMMAND_MAX_OUTPUT_BYTES`: maximum captured output for one Discord shell command. Default: `120000`.
- `HIDE_WORKSPACE_PATHS`: set to `1` to hide server workspace paths in Discord embeds. Default: `0`.
- `BOT_LANGUAGE`: `en` or `ko`. Default: `en`.
- `DISCORD_ALLOWED_USER_IDS`: comma-separated Discord user IDs allowed to run Codex. Empty means no user allowlist.
- `DISCORD_ALLOWED_ROLE_IDS`: comma-separated Discord role IDs allowed to run Codex. Empty means no role allowlist.
- `STALE_WORKSPACE_DAYS`: age threshold for `/clean`.

You can re-run the interactive configuration at any time:

```bash
codex-discord-agent configure
```

To skip interactive configuration during install, set:

```bash
CODEX_DISCORD_AGENT_SKIP_CONFIGURE=1
```

To skip the Codex CLI install/auth check during install, set:

```bash
CODEX_DISCORD_AGENT_SKIP_CODEX_SETUP=1
```

To install/check the CLI but skip the interactive login prompt, set:

```bash
CODEX_DISCORD_AGENT_SKIP_CODEX_AUTH=1
```

## Global CLI

The installer adds a global command:

```bash
codex-discord-agent status
codex-discord-agent restart
codex-discord-agent update
codex-discord-agent logs
codex-discord-agent check
codex-discord-agent configure
codex-discord-agent stop
```

## Discord Thread Commands

### Global Thread Profile

Send a normal text message in the configured parent channel to set a global profile for every managed thread. Use it for shared personality, name, tone, and response style.

Examples:

```text
Your name is Odin. Reply in concise Korean. Be direct, practical, and calm.
```

The saved profile applies to existing and new threads from the next Codex run. It does not interrupt a job that is already running.

Manage the profile from the parent channel:

```text
profile
profile clear

프로필
프로필 초기화
```

Attachments in the parent channel are ignored for the global profile.

### Thread Commands

Inside a managed thread:

```text
/help
/status
/settings
/queue
/doctor
/usage
/workspace
/reset
/stop
/logs
/clean
/shell <command>
/goal [args]
/plan [args]
/codexcmd command:<name> args:<args>

/도움말
/상태
/설정
/대기열
/진단
/사용량
/작업공간
/초기화
/중단
/로그
/정리
/터미널 <명령>
/목표 [인자]
/계획 [인자]
/코덱스명령 command:<이름> args:<인자>
```

The bot creates one pinned control panel per managed thread when the thread is created or first used. Each Codex run uses a single status embed that is edited in place as progress events, tool command output, and assistant output arrive, so the thread does not fill with partial response messages. Running status messages keep only the common controls: refresh and stop. Failed jobs show retry. Settings, usage, logs, queue, doctor checks, workspace details, server shell commands, and Codex slash command pass-throughs are available through slash commands. Use direct commands such as `/goal` and `/plan`, their Korean aliases such as `/목표` and `/계획`, or `/codexcmd` / `/코덱스명령` for any Codex slash command not registered directly. Shell commands require a configured Discord allowlist; if both allowlist variables are empty, `/shell` is disabled.
If the service restarts during a job, the bot marks the last running job as interrupted the next time the thread is used or checked. In-memory queued jobs are not restored after a restart.

## systemd

Manual service install from a checkout:

```bash
scripts/install-systemd-service.sh --enable-auto-update --start
```

Status:

```bash
codex-discord-agent status
sudo systemctl status codex-discord-agent
```

Logs:

```bash
codex-discord-agent logs
sudo journalctl -u codex-discord-agent -f
```

Restart and stop:

```bash
codex-discord-agent restart
codex-discord-agent stop
```

## Updates

Check for updates:

```bash
codex-discord-agent check
```

Apply updates:

```bash
codex-discord-agent update
```

The one-line installer enables a daily systemd update timer by default:

```bash
sudo systemctl status codex-discord-agent-update.timer
sudo systemctl list-timers codex-discord-agent-update.timer
```

Disable or enable the timer:

```bash
scripts/install-systemd-service.sh --disable-auto-update
scripts/install-systemd-service.sh --enable-auto-update
```

## Local Development

```bash
bun install
bun run typecheck
bun test
bun run start
```

## Codex Defaults

First request:

```bash
codex exec --json -m gpt-5.5 -c 'model_reasoning_effort="high"' --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C <workspace> -
```

Follow-up request:

```bash
codex exec resume --json -m gpt-5.5 -c 'model_reasoning_effort="high"' --dangerously-bypass-approvals-and-sandbox <sessionId> -
```

`danger-full-access` is a powerful setting. Use this bot only in trusted Discord servers and channels.
For production use, set `DISCORD_ALLOWED_USER_IDS` or `DISCORD_ALLOWED_ROLE_IDS`; otherwise every user who can write in a managed thread can ask Codex to run with full workspace access.
