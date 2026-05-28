# Ports & Adapters — Catalogue

> **Dependencies:** [architecture.md](architecture.md).

A **port** is an interface owned by the application/domain. An **adapter** is an implementation owned by infrastructure. This doc is the living index: every port the repo defines, every adapter that implements it.

Keep this file current. When you add a port, add a row. When you replace an adapter, update the row.

## How to read a port

```ts
// src/sensors/domain/ports/sensor-driver.port.ts
export const SENSOR_DRIVER_FACTORY = Symbol('SENSOR_DRIVER_FACTORY');

export interface SensorDriverPort {
  init(config: SensorConfig): Promise<void>;
  destroy(): Promise<void>;
  getState(): SensorReading;
  onEvent(cb: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}

export type SensorDriverFactory = (type: SensorType) => SensorDriverPort;
```

Two things in the same file: the **token** (Symbol, exported as `UPPER_SNAKE`) and the **interface**. Implementations import only the interface; consumers import the token to `@Inject(...)`.

## Catalogue

Status legend: ✅ canonical · 🚧 in transition · 📝 planned

### Sensors context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `SensorDriverPort` (`SENSOR_DRIVER_FACTORY`) | `DigitalGpioAdapter`, `UartCo2Adapter`, `MqttSensorAdapter`, `CameraSensorAdapter`, `MockGpioAdapter` (dev) | 🚧 — interface is [`ISensorDriver`](../src/sensors/sensor.interface.ts), drivers live in [src/sensors/drivers/](../src/sensors/drivers); rename per [naming-and-conventions.md](naming-and-conventions.md) when next touched | [sensor.interface.ts](../src/sensors/sensor.interface.ts) |
| `SensorRepositoryPort` | `DrizzleSensorRepository` | 📝 — currently the `sensors` Drizzle table is queried directly from [sensor.registry.ts](../src/sensors/sensor.registry.ts) and [status.command.ts](../src/telegram/commands/status.command.ts). Extract on next meaningful change. | — |
| `SensorQueryPort` (read model for other contexts) | `DrizzleSensorQuery` | 📝 — needed so `telegram/` stops importing `sensors` schema. | — |
| `PigpioGateway` | (internal — single implementation, intentional infrastructure-only utility) | 🚧 keep as gateway, do not promote to port | [pigpio.gateway.ts](../src/sensors/drivers/pigpio.gateway.ts) |

### Events context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `EventRepositoryPort` (`EVENT_REPOSITORY`) | `DrizzleEventRepository`, `InMemoryEventRepository` (tests/dev) | ✅ canonical | [event-repository.port.ts](../src/events/domain/ports/event-repository.port.ts) |
| `NotifierPort` (`NOTIFIER`) | `EventNotifierService` (delegating application adapter), `TelegramNotifierAdapter` | 🚧 — Telegram implements the sender, while bot gateway extraction is still pending. | [notifier.port.ts](../src/events/domain/ports/notifier.port.ts) |
| `SensorEventSourcePort` (`SENSOR_EVENT_SOURCE`) | `SensorRegistry` (temporary, until sensors migrate) | 🚧 — events no longer import `SensorRegistry` directly; the implementation still lives in the transitional sensors context. | [sensor-event-source.port.ts](../src/events/domain/ports/sensor-event-source.port.ts) |

### Telegram context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `BotGateway` | `GrammyBotGateway` | 📝 — single intentional gateway; do not abstract grammY itself further. | [bot.service.ts](../src/telegram/bot.service.ts) |
| `RolePort` | `DrizzleRoleRepository` | 📝 | [role.guard.ts](../src/telegram/guards/role.guard.ts) |

### Camera context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `MotionControlPort` | `MotionDaemonAdapter` (systemctl) | 🚧 | [motion.service.ts](../src/camera/motion.service.ts) |
| `CloudUploadPort` | `RcloneGdriveUploader`, `NoopUploader` (dev) | 🚧 | [upload.service.ts](../src/camera/upload.service.ts) |
| `MediaRepositoryPort` | `DrizzleMotionEventRepository` | 📝 | [schema.ts](../src/database/schema.ts) |
| `SnapshotPort` (`SNAPSHOT`) | `FfmpegSnapshotAdapter` (caches via TTL), `StubSnapshotAdapter` (dev) | 📝 — referenced by [specs/20-camera.md](specs/20-camera.md). Cache TTL lives inside the adapter. | — |

### Network context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `NetworkProbePort` | `OsNetworkProbe` (ping/iwgetid) | 🚧 | [network.service.ts](../src/network/network.service.ts) |

### Cross-cutting

| Port | Adapters | Status | Source |
|---|---|---|---|
| `ClockPort` (`CLOCK`) | `SystemClockAdapter`, fixed objects in tests | 🚧 — introduced for events; still planned for the rest of the repo. | [clock.port.ts](../src/events/domain/ports/clock.port.ts) |
| `ConfigPort` | `YamlConfigLoader` | 🚧 | [config.loader.ts](../src/config/config.loader.ts) |
| `LoggerPort` | (use Nest `Logger` for now) | ✅ — Nest's `Logger` is the contract; do not invent a wrapper. |

## Rules

1. **One port per cross-boundary concept.** Not one port per class.
2. **A port is owned by the context that calls it**, not the one that implements it. `NotifierPort` lives under `events/domain/ports/`, even though Telegram implements it.
3. **Single-implementation infrastructure utilities** (pigpio gateway, Motion daemon wrapper) stay as gateways — *not* every external dependency needs an interface. The cost is paid only when (a) we want to mock for tests **or** (b) we expect to swap the tech.
4. **Adapter file names** match the port's intent + the tech: `DrizzleEventRepository`, `RcloneGdriveUploader`, `GrammyBotGateway`. See [naming-and-conventions.md](naming-and-conventions.md).
5. **Test doubles** (`MockGpioAdapter`, `FixedClock`, `InMemoryEventRepository`) are real adapters and live next to the production ones, not under `test/`. They ship in dev builds; production wiring picks the real adapter via `NODE_ENV` or config.
6. **Never** put two ports' contracts in one interface. Split.

## Adding a new port — checklist

1. Define the interface + token Symbol in `src/<context>/domain/ports/<name>.port.ts`.
2. Write the use case in `application/` that depends on the token via `@Inject`.
3. Implement at least one real adapter in `infrastructure/`.
4. Implement an in-memory or mock adapter for tests (unless trivial).
5. Wire both in `<context>.module.ts` — production binding selected by env/config.
6. Add a row to this catalogue.
7. Cover the use case with the in-memory adapter; cover the real adapter with an integration test ([testing.md](testing.md)).
