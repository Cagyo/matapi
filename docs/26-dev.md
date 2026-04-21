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

Web panel at `http://localhost:3001/dev/simulate`:

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

### Minimum Required Tests

| Area | Type | Description |
|------|------|-------------|
| Sensor driver contract | Unit | Each driver implements `init`, `destroy`, `getState`, `onEvent` |
| Event queue drain | Integration | Insert 1000 events → drain → verify all sent with rate limiting |
| Config hot-reload | Integration | Modify SQLite → verify sensors update without restart |
| Bot commands | Integration | grammY test framework — verify responses and role guards |
| Aggregation | Unit | Offline events → aggregated summary preserving chronological order |
| DB migrations | Integration | Apply all migrations to empty DB → verify schema |
| YAML validation | Unit | Valid and invalid YAML → correct accept/reject |
| Pin uniqueness | Unit | Duplicate GPIO pins → verify rejection |

### Test Runner

Jest or Vitest. No preference — pick one and be consistent.

### What NOT to Test

- NestJS module wiring (framework's job)
- grammY internals
- pigpio bindings (can't run on dev machine anyway)
- SQLite itself

## Git Workflow

- `main` branch is production — what gets pulled by OTA update
- Feature branches for development
- Pre-commit hook rejects `.env` commits
- No CI/CD needed initially — test locally, push to main
