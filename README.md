# codex-discord-agent

Run Codex from Discord threads. Each managed Discord thread gets its own isolated workspace and Codex session.

## What It Does

- Watches one Discord guild and one parent channel.
- Creates one workspace per thread: `BASE_WORKSPACE_DIR/<guildId>/<threadId>`.
- Sends each user message in the thread to Codex.
- Keeps follow-up messages in the same thread attached to the same Codex session.
- Shows Discord typing indicators and an editable job status message.
- Supports English and Korean bot messages with `BOT_LANGUAGE=en|ko`.
- Supports `/codex` thread commands, file attachments, image attachments, cancellation, session reset, and stale workspace cleanup.
- Installs as a systemd service with an optional daily auto-update timer.

## Requirements

The one-line installer is designed for Linux servers with systemd.

Required:

- Linux with systemd
- root access or a user with `sudo`
- Discord server admin permissions
- a Discord bot token
- Codex CLI installed and logged in

The installer checks and installs these system packages when missing:

- `curl`
- `tar`
- `unzip`

If you are not root, the installer asks for your `sudo` password at the start. Bun is installed automatically when missing.

Codex must be logged in before the bot can use it:

```bash
codex login
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

   Select this scope:

   - `bot`

   Select these bot permissions:

   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
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
CODEX_REASONING_EFFORT=high
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
- `CODEX_REASONING_EFFORT`: reasoning effort. Default: `high`.
- `BOT_LANGUAGE`: `en` or `ko`. Default: `en`.
- `DISCORD_ALLOWED_USER_IDS`: comma-separated Discord user IDs allowed to run Codex. Empty means no user allowlist.
- `DISCORD_ALLOWED_ROLE_IDS`: comma-separated Discord role IDs allowed to run Codex. Empty means no role allowlist.
- `STALE_WORKSPACE_DAYS`: age threshold for `/codex clean`.

You can re-run the interactive configuration at any time:

```bash
codex-discord-agent configure
```

To skip interactive configuration during install, set:

```bash
CODEX_DISCORD_AGENT_SKIP_CONFIGURE=1
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

Inside a managed thread:

```text
/codex help
/codex status
/codex workspace
/codex reset
/codex stop
/codex logs
/codex clean
```

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
codex exec --json --skip-git-repo-check -s danger-full-access -m gpt-5.5 -c 'model_reasoning_effort="high"' -C <workspace> -
```

Follow-up request:

```bash
codex exec resume --json -m gpt-5.5 -c 'model_reasoning_effort="high"' <sessionId> -
```

`danger-full-access` is a powerful setting. Use this bot only in trusted Discord servers and channels.
