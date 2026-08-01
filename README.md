# Home Worker

Home automation and security monitoring system on Raspberry Pi.
NestJS worker + grammY Telegram bot. SQLite (Drizzle ORM), PM2.

See `docs/` for the full specification, starting at [docs/00-overview.md](docs/00-overview.md).

## Quick start (development)

Requires Node.js 22 with [Corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`). Yarn 4.13 is pinned in `package.json`.

```bash
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN to a test bot token.
# Optionally adjust DATABASE_PATH (defaults to ./data/dev.db in dev).
echo "DATABASE_PATH=./data/dev.db" >> .env
echo "NODE_ENV=development" >> .env

yarn install
yarn db:generate       # generate initial migration from schema
yarn db:migrate        # apply migrations
yarn start:dev
```

In dev mode (`NODE_ENV=development`), digital sensors use `MockGpioDriver`.
A simulator panel is served at `http://localhost:4000/dev/simulate`
(on the worker's loopback HTTP port) — toggle digital sensors ON/OFF and slide
the CO₂ value to drive the same pipeline as real hardware. See
[docs/specs/26-dev.md](docs/specs/26-dev.md).

## Production install

```bash
curl -sSL https://raw.githubusercontent.com/<user>/home-worker/main/scripts/install.sh | bash
```

See [docs/25-install.md](docs/25-install.md).

## Project layout

Mirrors [docs/00-overview.md](docs/00-overview.md):

- `src/database` — Drizzle schema, SQLite (WAL) module, backup service.
- `src/sensors` — driver interface, registry, drivers (digital, uart, mqtt, camera, mock).
- `src/events` — write-side queue, drain processor, aggregation.
- `src/telegram` — grammY bot, commands, role guard, conversations.
- `src/camera` — Motion daemon control, completed-video registration, local cleanup.
- `src/archive` — direct Google Drive authorization, resumable uploads, verification, and retention.
- `src/network` — heartbeat + connectivity watchdog.
- `src/config` — YAML defaults loader.
- `scripts` — install / update / system-update / setup wizard.
- `migrations` — Drizzle Kit output.
- `locales/en.ts` — string table.

## Phase 0 status

Implemented:
- DatabaseModule with WAL, busy_timeout, foreign_keys, auto-migrate on boot.
- Drizzle schema for all Phase 0–2 tables.
- Sensor registry with type→driver factory and dev mock.
- Event queue + drain processor (at-least-once delivery).
- grammY bot wired with `autoRetry` + runner; `/claim_admin`, `/status`, `/ping`, `/help`.
- Heartbeat ping when `HEARTBEAT_URL` set.
- PID lockfile + graceful shutdown.

Stubs (Phase 1+):
- Real `pigpio-client` wiring in `DigitalDriver`.
- UART, MQTT, Camera drivers.
- Motion / Upload / Cleanup services.
- Setup wizard.
