# Home Worker — Agent Guide

NestJS worker + grammY Telegram bot for home automation/security on Raspberry Pi.
Single-package repo. Target runtime: Raspberry Pi 3+ / Raspbian / Node 20 / PM2.

> **Token rule:** Before reading any `docs/*.md`, open [docs/INDEX.md](docs/INDEX.md) and load only the docs that match the task. Do not load the whole `docs/` folder.

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
- Env keys: see [docs/00-overview.md](docs/00-overview.md) → *Environment Variables*

For deeper context, route through [docs/INDEX.md](docs/INDEX.md).

## Common Tasks → Docs

| Task | Load |
|---|---|
| Add a digital (GPIO) sensor | 02, 03 |
| Add UART/CO2 sensor logic | 02, 04 |
| Add a Telegram command | 06 + matching `bot-cmd-*` doc |
| Touch event queue / notifications | 05, 19 |
| Camera / motion / Drive sync | 20, 21, 15 |
| OTA / system update | 24, 13, 18 |
| Install / boot / systemd | 25, 22, 23 |
| DB schema change | 01 (then `yarn db:generate`) |

## Conventions

- TypeScript strict; no `any` in module boundaries.
- Drizzle: schema lives in [src/database/schema.ts](src/database/schema.ts); never hand-edit files in `migrations/` — regenerate via `yarn db:generate`.
- Sensor drivers implement [`SensorDriver`](src/sensors/sensor.interface.ts) and register through [src/sensors/sensor.registry.ts](src/sensors/sensor.registry.ts).
- Telegram commands live in `src/telegram/commands/` and follow the pattern in [src/telegram/commands/status.command.ts](src/telegram/commands/status.command.ts).
- All times stored as Unix epoch (integer); format using `date-fns-tz` with `TIMEZONE` env.
- Use `pino` via Nest logger; never `console.log` in production paths.
- I18n strings: [src/locales/en.ts](src/locales/en.ts) — no hardcoded user-facing text.

## Hard Rules

- **Secrets:** never log `TELEGRAM_BOT_TOKEN`, chat IDs, or `.env` contents. `.env` is gitignored — do not commit.
- **Migrations:** edit `schema.ts` then regenerate; do not hand-edit `migrations/0000_*.sql` or `migrations/meta/`.
- **GPIO:** worker connects to `pigpiod` over socket; do not run as root, do not call `pigpio` C library directly.
- **Destructive ops:** confirm before touching `data/*.db*`, running `prisma migrate reset` equivalents, or `git push --force`.
- **Pi resource budget:** keep memory < 512 MB (PM2 will restart). Prefer streaming over buffering for camera/Drive.

## Excluded From Context

See [.claudeignore](.claudeignore). In short: `data/`, `dist/`, `node_modules/`, `migrations/meta/`, `*.db*`, `*.log`, `.env*`, lockfiles.
