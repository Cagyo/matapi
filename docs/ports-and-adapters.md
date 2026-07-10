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
| `SensorDriverPort` (`SENSOR_DRIVER_FACTORY`) | `DigitalGpioAdapter`, `UartCo2Adapter`, `MqttSensorAdapter`, `CameraSensorAdapter`, `MockGpioAdapter` (dev), `MockUartCo2Adapter` (dev) | ✅ canonical — env-driven factory in [sensor-driver.factory.ts](../src/sensors/infrastructure/sensor-driver.factory.ts) selects mocks for `NODE_ENV=development` | [sensor-driver.port.ts](../src/sensors/domain/ports/sensor-driver.port.ts) |
| `SensorRepositoryPort` (`SENSOR_REPOSITORY`) | `DrizzleSensorRepository`, `InMemorySensorRepository` (tests) | ✅ canonical | [sensor-repository.port.ts](../src/sensors/domain/ports/sensor-repository.port.ts) |
| `SensorLogRepositoryPort` (`SENSOR_LOG_REPOSITORY`) | `DrizzleSensorLogRepository`, `InMemorySensorLogRepository` (tests) | ✅ canonical — drives buffered UART log flushing, digital GPIO event logging, **and** `/logs` recent-entry queries (`findRecent(sensorId, { limit, since })`). | [sensor-log-repository.port.ts](../src/sensors/domain/ports/sensor-log-repository.port.ts) |
| `SensorQueryPort` (`SENSOR_QUERY`) read model for other contexts | `DrizzleSensorQuery`, `InMemorySensorQuery` (tests) | ✅ canonical — `listEnabled`, `findById`, and `findByName` (returns active **or** archived sensor; `/logs` uses archive fallback). | [sensor-query.port.ts](../src/sensors/domain/ports/sensor-query.port.ts) |
| `SensorHealthPort` (`SENSOR_HEALTH`) | `SensorRegistryService` (live `healthCheck()` per active driver; failures coerced to `false`) | ✅ canonical — powers `/status` and `/health` online counts. | [sensor-health.port.ts](../src/sensors/application/ports/sensor-health.port.ts) |
| `PigpioGateway` | (internal — single implementation, intentional infrastructure-only utility) | ✅ keep as gateway, do not promote to port | [pigpio.gateway.ts](../src/sensors/infrastructure/pigpio.gateway.ts) |

### Events context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `EventRepositoryPort` (`EVENT_REPOSITORY`) | `DrizzleEventRepository`, `InMemoryEventRepository` (tests/dev) | ✅ canonical | [event-repository.port.ts](../src/events/domain/ports/event-repository.port.ts) |
| `NotifierPort` (`NOTIFIER`) | `EventNotifierService` (delegating application adapter), `TelegramNotifierAdapter`, `ConsoleNotifierAdapter` (dev) | 🚧 — Telegram implements the sender, while bot gateway extraction is still pending. Exposes `notify` (broadcast, offline drain), `notifyUser` (per-recipient text, spec 19 filtering) and `notifyUserPhoto` (photo + caption, spec 19/20 motion events). | [notifier.port.ts](../src/events/domain/ports/notifier.port.ts) |
| `RecipientDirectoryPort` (`RECIPIENT_DIRECTORY`) | `RecipientDirectoryService` (application seam; empty until registered), `TelegramRecipientDirectoryAdapter` (registered at bootstrap by `GrammyBotGateway`) | ✅ canonical — read model of who receives notifications (`listRecipients`, `isSensorMuted`). Runtime registration seam avoids the events→telegram import cycle, mirroring `NotifierPort`. | [recipient.port.ts](../src/events/domain/ports/recipient.port.ts) |
| `NotificationOptions` (`NOTIFICATION_OPTIONS`) | factory in `event.module.ts` (timezone from `TIMEZONE` env, default `Europe/Kyiv`) | ✅ canonical — supplies the timezone used for quiet-hours evaluation in `NotificationService`. | [notification-options.port.ts](../src/events/application/ports/notification-options.port.ts) |
| `SensorEventSourcePort` (`SENSOR_EVENT_SOURCE`) | `SensorRegistryService` (sensors application layer) | ✅ canonical — events imports the application service via the sensors module. | [sensor-event-source.port.ts](../src/events/domain/ports/sensor-event-source.port.ts) |

### Telegram context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `BotGateway` | `GrammyBotGateway` | 📝 — single intentional gateway; do not abstract grammY itself further. | [bot.service.ts](../src/telegram/bot.service.ts) |
| `UserRepositoryPort` (`USER_REPOSITORY`) | `DrizzleUserRepository`, `InMemoryUserRepository` (mock/dev/tests) | ✅ canonical — `findByName` is case-insensitive and strips a leading `@`. | [user-repository.port.ts](../src/telegram/domain/ports/user-repository.port.ts) |
| `AdminClaimCredentialPort` (`ADMIN_CLAIM_CREDENTIAL`) | `EnvAdminClaimCredentialAdapter` | ✅ canonical — verifies the setup-generated `CLAIM_ADMIN_TOKEN` without exposing its value. | [admin-claim-credential.port.ts](../src/telegram/domain/ports/admin-claim-credential.port.ts) |
| `InviteCodeRepositoryPort` (`INVITE_CODE_REPOSITORY`) | `DrizzleInviteCodeRepository`, `InMemoryInviteCodeRepository` (mock/tests) | ✅ canonical | [invite-code-repository.port.ts](../src/telegram/domain/ports/invite-code-repository.port.ts) |
| `DirectMessengerPort` (`DIRECT_MESSENGER`) | `TelegramDirectMessenger` (logs in mock mode when no bot is bound) | ✅ canonical — used by `/start`, `/promote`, `/demote` for one-off notifications. | [direct-messenger.port.ts](../src/telegram/domain/ports/direct-messenger.port.ts) |
| `RolePort` | `DrizzleRoleRepository` | 📝 | [role.guard.ts](../src/telegram/guards/role.guard.ts) |

### Camera context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `MotionControlPort` (`MOTION_CONTROL`) | `MotionDaemonAdapter` (systemctl, incl. `restart()`), `StubMotionControlAdapter` (dev) | ✅ | [motion-daemon.adapter.ts](../src/camera/infrastructure/motion-daemon.adapter.ts) |
| `DriveStatusPort` (`DRIVE_STATUS`) | `RcloneDriveStatusAdapter` (rclone `about`), `StubDriveStatusAdapter` (dev) | ✅ read side for `/gdrive` (spec 21) | [drive-status.port.ts](../src/camera/domain/ports/drive-status.port.ts) |
| `DriveSyncPort` (`DRIVE_SYNC`) | `RcloneDriveSyncAdapter` (`ionice -c3 rclone copy/delete/copyto`, additive), `StubDriveSyncAdapter` (dev) | ✅ upload + Drive prune + backup upload (spec 21) | [drive-sync.port.ts](../src/camera/domain/ports/drive-sync.port.ts) |
| `LocalStoragePort` (`LOCAL_STORAGE`) | `FsLocalStorageAdapter` (`df -P` + fs delete/prune), `StubLocalStorageAdapter` (dev) | ✅ disk usage + local cleanup (spec 21) | [local-storage.port.ts](../src/camera/domain/ports/local-storage.port.ts) |
| `RetentionPrunePort` (`RETENTION_PRUNE`) | `DrizzleRetentionPruneAdapter` (emergency events/sensor-log prune), `StubRetentionPruneAdapter` (dev) | ✅ emergency disk recovery (spec 21) | [retention-prune.port.ts](../src/camera/domain/ports/retention-prune.port.ts) |
| `DbBackupPort` (`DB_BACKUP`) | `SqliteDbBackupAdapter` (SQLite online backup), `StubDbBackupAdapter` (dev) | ✅ daily DB backup (spec 21) | [db-backup.port.ts](../src/camera/domain/ports/db-backup.port.ts) |
| `MediaRepositoryPort` (`MEDIA_REPOSITORY`) | `DrizzleMediaRepository`, `InMemoryMediaRepository` (dev) | ✅ read model | [drizzle-media.repository.ts](../src/camera/infrastructure/drizzle-media.repository.ts) |
| `MediaWriterPort` (`MEDIA_WRITER`) | `DrizzleMediaRepository`, `InMemoryMediaRepository` (dev) — same instance, aliased | ✅ write side for motion hooks (spec 20) | [media-writer.port.ts](../src/camera/domain/ports/media-writer.port.ts) |
| `SnapshotPort` (`SNAPSHOT`) | `FfmpegSnapshotAdapter` (caches via TTL), `StubSnapshotAdapter` (dev) | ✅ | [snapshot.port.ts](../src/camera/domain/ports/snapshot.port.ts) |
| `MotionAlertPort` (`MOTION_ALERT`) | `EventsMotionAlertAdapter` (delegates to events `NotificationService`), `StubMotionAlertAdapter` (dev) | ✅ motion notification (spec 19, 20) | [motion-alert.port.ts](../src/camera/domain/ports/motion-alert.port.ts) |
| `AdminAlertPort` (`ADMIN_ALERT`) | `AdminAlertService` (register/clear seam) ← `TelegramAdminAlertAdapter` registered at bot bootstrap | ✅ daemon up/down + Drive-sync / emergency-disk alerts (specs 20, 21) | [admin-alert.port.ts](../src/camera/domain/ports/admin-alert.port.ts) |

### System context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `SystemHealthPort` (`SYSTEM_HEALTH`) | `OsSystemHealthAdapter` (`df -kP`, `/sys/class/thermal`, `process.memoryUsage`, `os.totalmem`, `process.uptime`, `fs.stat` on `DATABASE_PATH`) | ✅ canonical — drives `/health`. Disk / CPU temp / db size degrade to `null` on dev hosts without throwing. | [system-health.port.ts](../src/system/domain/ports/system-health.port.ts) |

### Network context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `HeartbeatClientPort` (`HEARTBEAT_CLIENT`) | `FetchHeartbeatAdapter` (global `fetch`, 10s `AbortSignal.timeout`, no-op when `HEARTBEAT_URL` unset) | ✅ canonical — external dead-system heartbeat (spec 22). | [heartbeat-client.port.ts](../src/network/domain/ports/heartbeat-client.port.ts) |
| `BotRunnerPort` (`BOT_RUNNER`) | `BotRunnerRegistry` (application register/clear seam) ← `GrammyBotGateway` registered at bot bootstrap | ✅ canonical — bot-polling watchdog reads last-update + force-restarts the grammY runner (spec 22). Runtime seam avoids a network→telegram cycle, mirroring `AdminAlertPort`. | [bot-runner.port.ts](../src/network/domain/ports/bot-runner.port.ts) |
| `WatchdogPort` (`WATCHDOG`) | `FileWatchdogAdapter` (`/dev/watchdog`, magic-close disarm), `StubWatchdogAdapter` (dev / disabled) | ✅ canonical — Pi hardware watchdog, selected by `HARDWARE_WATCHDOG_ENABLED` (spec 22). | [watchdog.port.ts](../src/network/domain/ports/watchdog.port.ts) |
| `NetworkProbePort` | `OsNetworkProbe` (ping/iwgetid) | 📝 planned — connectivity probe / 4G failover (spec 22, Phase 2). | — |

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
