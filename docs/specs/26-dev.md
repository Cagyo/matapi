# 26 — Development Workflow

## Dependencies
- 02-sensor-core.md (mock driver)
- 00-overview.md (project structure)

## Dev Environment

- Run on any machine (Mac/Linux/Windows with WSL)
- `NODE_ENV=development` activates MockGpioDriver
- SQLite runs natively (no Pi needed)
- grammY connects to real Telegram API (use separate test bot token)
- Motion integration: skip or mock

## Mock GPIO Simulator

Web panel at `http://localhost:4000/dev/simulate`:

```
┌─────────────────────────────────────┐
│  Home Worker — Dev Simulator        │
│                                     │
│  door_1 (GPIO 17)    [ON]  [OFF]   │
│  door_2 (GPIO 27)    [ON]  [OFF]   │
│  water_1 (GPIO 22)   [ON]  [OFF]   │
│  water_2 (GPIO 23)   [ON]  [OFF]   │
│  window_1 (GPIO 24)  [ON]  [OFF]   │
│                                     │
│  CO2 (UART)     [slider 400-2000]  │
└─────────────────────────────────────┘
```

Buttons trigger `MockGpioDriver.simulateChange()` which fires the same event flow as real GPIO. Full pipeline tested: driver → event queue → notification → Telegram.

## Dev .env

```bash
NODE_ENV=development
TELEGRAM_BOT_TOKEN=<test_bot_token>
DATABASE_PATH=./data/dev.db
TIMEZONE=Europe/Kyiv
HEARTBEAT_URL=
```

## Testing Strategy

**Test runner: Vitest** (the only runner in this repo). Test placement, the three-tier model (unit / use-case / integration), determinism rules, and what NOT to test are defined once in [../testing.md](../testing.md). This spec does not duplicate that — examples below illustrate the dev-loop scenarios specific to this project; for the canonical rules, follow `testing.md`.

### Representative scenarios per tier

| Tier | Example SUTs from this repo |
|------|------------------------------|
| Unit (domain) | `GpioPin` value object, severity parsing, quiet-hours overnight span, aggregation of offline events into a chronological summary |
| Use case (application) | `DrainEventQueueUseCase` with `InMemoryEventRepository` + stub notifier + fixed clock; `ReloadSensorsUseCase` with mock driver factory; pin-uniqueness rejection in `AddSensorUseCase` |
| Integration (infrastructure) | `DrizzleEventRepository` against `:memory:` SQLite; `DigitalGpioAdapter` against a mocked `PigpioGateway`; grammY handlers via the official test transport |

Do **not** test: NestJS DI itself, grammY internals, Drizzle's query builder, pigpio bindings (unavailable off-Pi), SQLite itself.

## Git Workflow

- `main` branch is production — what gets pulled by OTA update
- Feature branches for development
- Pre-commit hook rejects `.env` commits
- No CI/CD needed initially — test locally, push to main
