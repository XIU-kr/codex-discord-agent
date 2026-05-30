# Repository Guidelines

## Project Structure & Module Organization

This Bun + TypeScript Discord bot runs Codex sessions from managed Discord threads.

- `src/` contains runtime code. `index.ts` wires Discord events; modules such as `codex.ts`, `workspaces.ts`, `attachments.ts`, and `discordFormat.ts` keep domain behavior separated.
- `test/` contains Bun unit tests named `*.test.ts`, usually matching a source module.
- `bin/codex-discord-agent` is the installed CLI entrypoint.
- `scripts/` and `install.sh` support setup, updates, and configuration.
- `deploy/` contains systemd service and timer templates.
- `.env.example` documents configuration; local `.env` files contain secrets and must not be committed.

## Build, Test, and Development Commands

- `bun install` installs dependencies from `bun.lock`.
- `bun run dev` runs `src/index.ts` with watch mode for local development.
- `bun run start` runs the bot once using the current environment.
- `bun run typecheck` runs `tsc --noEmit` with strict TypeScript settings.
- `bun test test/*.test.ts` or `bun run test` runs the full test suite.
- `scripts/configure-env.sh` creates or updates local `.env` values.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Prefer named exports for reusable helpers and keep side effects in entrypoints such as `src/index.ts`. Match the existing style: two-space indentation, double quotes, semicolons, and `type` imports where only types are needed. Use camelCase for functions and variables, PascalCase for interfaces/types, and all-caps snake case for environment variables.

Keep modules focused. Put Discord API wrappers in `discordApi.ts`, formatting logic in `discordFormat.ts`, workspace persistence in `workspaces.ts`, and Codex CLI behavior in `codex.ts`.

## Testing Guidelines

Tests use `bun:test` with `describe`, `test`, and `expect`. Place new tests in `test/<module>.test.ts` and cover parsing, formatting, config validation, queue/session behavior, and filesystem edge cases when changed. Run `bun run typecheck` and `bun run test` before submitting.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, sentence-case messages, for example `Improve Discord Codex UX and resilience` or `Add Codex watchdog timeouts`. Follow that pattern and keep each commit scoped to one change.

Pull requests should include a clear summary, test results, and any configuration or deployment impact. Link related issues when available. Include screenshots or copied Discord output when thread messages, message panels, or command responses change.

## Security & Configuration Tips

Never commit `.env`, Discord tokens, generated workspaces, or Codex session data. Use `.env.example` for public configuration examples. When changing install or systemd behavior, verify paths and environment variables for both checkout development and installed service usage.
