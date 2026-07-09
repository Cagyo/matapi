# Home Worker — Agent Guide

NestJS worker + grammY Telegram bot for home automation/security on Raspberry Pi.
Single-package repo. Target runtime: Raspberry Pi 3+ / Raspbian / Node 20 / PM2.

**Architecture:** Hexagonal (ports & adapters), feature-sliced under `src/<context>/{domain,application,infrastructure}/`. Non-negotiable for new modules — see [docs/architecture.md](docs/architecture.md).

> **Token rule:** Before reading any `docs/*.md` or `docs/specs/*.md`, open [docs/INDEX.md](docs/INDEX.md) and load only the docs that match the task. Do not bulk-load either folder.

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20 (LTS, pinned) |
| Package manager | Yarn 4.13 (via Corepack; pinned in `package.json` → `packageManager`) |
| Framework | NestJS 10 |
| DB | SQLite (better-sqlite3) + Drizzle ORM, WAL mode |
| Bot | grammY + `@grammyjs/{runner,auto-retry,conversations}` |
| GPIO | pigpio-client (socket to `pigpiod`) |
| UART | serialport (CO2 sensor) |
| Camera | Motion daemon (systemd, controlled via sudo) |
| Cloud sync | rclone → Google Drive |
| Process mgr | PM2 (`max_memory_restart=512M`, `instances=1`) |
| Tests | Vitest |

## Commands

> Yarn 4 is managed by [Corepack](https://nodejs.org/api/corepack.html). Run `corepack enable` once per machine; Node will then use the version pinned in `package.json`.

```bash
yarn install            # install deps (use --immutable in CI / on Pi)
yarn build              # nest build
yarn start:dev          # watch mode
yarn start              # node dist/main.js
yarn test               # vitest run
yarn lint               # eslint --fix
yarn db:generate        # drizzle-kit generate (after schema.ts edits)
yarn db:migrate         # apply migrations
```

## Layout (links → source of truth)

- Entry: [src/main.ts](src/main.ts), [src/app.module.ts](src/app.module.ts)
- DB schema: [src/database/schema.ts](src/database/schema.ts)
- Sensor contract: [src/sensors/sensor.interface.ts](src/sensors/sensor.interface.ts)
- Sensor drivers: [src/sensors/drivers/](src/sensors/drivers)
- Event queue: [src/events/](src/events)
- Bot + commands: [src/telegram/](src/telegram)
- Camera / Drive: [src/camera/](src/camera)
- Config defaults: [config/defaults.yml](config/defaults.yml)
- Env keys: see [docs/specs/00-overview.md](docs/specs/00-overview.md) → *Environment Variables*

For deeper context, route through [docs/INDEX.md](docs/INDEX.md).

## Architecture Docs — `docs/*.md`

| Topic | Doc |
|---|---|
| Hexagonal layers, dependency rule, folder layout | [architecture.md](docs/architecture.md) |
| Port catalogue + adapter list (living index) | [ports-and-adapters.md](docs/ports-and-adapters.md) |
| Nest DI tokens, composition root, env-driven adapter selection | [dependency-injection.md](docs/dependency-injection.md) |
| Domain errors, adapter↔interface boundary mapping | [error-handling.md](docs/error-handling.md) |
| Vitest tiers (unit / use-case / integration) | [testing.md](docs/testing.md) |
| File names, class suffixes, folder names | [naming-and-conventions.md](docs/naming-and-conventions.md) |
| Conventional Commits | [commits.md](docs/commits.md) |

## Common Tasks → Specs (`docs/specs/`)

Pair each spec doc with the relevant architecture doc above.

| Task | Load |
|---|---|
| Add a digital (GPIO) sensor | specs 02, 03 |
| Add UART/CO2 sensor logic | specs 02, 04 |
| Add a Telegram command | specs 06 + matching `bot-cmd-*` doc |
| Touch event queue / notifications | specs 05, 19 |
| Camera / motion / Drive sync | specs 20, 21, 15 |
| OTA / system update | specs 24, 13, 18 |
| Install / boot / systemd | specs 25, 22, 23 |
| DB schema change | specs 01 (then `yarn db:generate`) |

## Conventions

- **Hexagonal layering is mandatory for new modules** — see [docs/architecture.md](docs/architecture.md). Existing modules are in transition; rehome to `domain/`/`application/`/`infrastructure/` on the next meaningful change.
- TypeScript strict; no `any` in module boundaries.
- Drizzle: schema lives in [src/database/schema.ts](src/database/schema.ts); never hand-edit files in `migrations/` — regenerate via `yarn db:generate`. Long-term home is per-context `infrastructure/db/` ([docs/architecture.md](docs/architecture.md#target-layout-mapped-to-current-code)).
- Sensor drivers implement [`SensorDriver`](src/sensors/sensor.interface.ts) and register through [src/sensors/sensor.registry.ts](src/sensors/sensor.registry.ts) — the port will be renamed `SensorDriverPort` per [docs/naming-and-conventions.md](docs/naming-and-conventions.md) when next touched.
- Telegram commands live in `src/telegram/commands/` and follow the pattern in [src/telegram/commands/status.command.ts](src/telegram/commands/status.command.ts); new handlers depend on application-layer ports, not Drizzle directly.
- All times stored as Unix epoch (integer); format using `date-fns-tz` with `TIMEZONE` env.
- Use `pino` via Nest logger; never `console.log` in production paths.
- I18n strings: [src/locales/en.ts](src/locales/en.ts) — no hardcoded user-facing text.
- Errors: typed domain error classes, mapped at the interface boundary — see [docs/error-handling.md](docs/error-handling.md).

## Hard Rules

- **Secrets:** never log `TELEGRAM_BOT_TOKEN`, chat IDs, or `.env` contents. `.env` is gitignored — do not commit.
- **Migrations:** edit `schema.ts` then regenerate; do not hand-edit `migrations/0000_*.sql` or `migrations/meta/`.
- **GPIO:** worker connects to `pigpiod` over socket; do not run as root, do not call `pigpio` C library directly.
- **Destructive ops:** confirm before touching `data/*.db*`, running `prisma migrate reset` equivalents, or `git push --force`.
- **Pi resource budget:** keep memory < 512 MB (PM2 will restart). Prefer streaming over buffering for camera/Drive.

## Excluded From Context

See [.claudeignore](.claudeignore). In short: `data/`, `dist/`, `node_modules/`, `migrations/meta/`, `*.db*`, `*.log`, `.env*`, lockfiles.

## Advisor subagent (Claude Code only)
<!-- codex/non-Claude agents: ignore this section — it relies on the Claude Code Task/subagent system, which you do not have. -->
An `advisor` subagent (Fable 5, or Opus 4.8 if Fable is unavailable; read-only) is available for high-leverage calls. Consult it ONLY when the task is: an architecture decision with lasting consequences, a plan review before a large slice, debugging that has resisted 2+ fix attempts, or a risky data-model / concurrency / sync tradeoff. Do NOT use it for routine questions, lookups, or anything a grep would settle — it is the most expensive model in the fleet. Prefer resuming the same advisor (SendMessage) over spawning a fresh one, to avoid cold-start context cost.
