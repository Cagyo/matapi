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
  destroy(context?: SensorDriverShutdownContext): Promise<void>;
  getState(): SensorReading;
  onEvent(cb: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}

export type SensorDriverFactory = (type: SensorType) => SensorDriverPort;
```

Two things in the same file: the **token** (Symbol, exported as `UPPER_SNAKE`) and the **interface**. Implementations import only the interface; consumers import the token to `@Inject(...)`.

## Catalogue

Status legend: ✅ canonical · 🚧 in transition · 📝 planned

### Features context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `FeatureQueryPort` (`FEATURE_QUERY`) | `DrizzleFeatureQuery`, `InMemoryFeatureQuery` (tests/dev) | ✅ canonical read projection for configuration export and Camera's live-stream capability. Exported by `FeatureModule`; consumers import the module rather than either adapter. | [feature-query.port.ts](../src/features/domain/ports/feature-query.port.ts) |
| `FeatureRepositoryPort` (`FEATURE_REPOSITORY`) | `DrizzleFeatureRepository`, `InMemoryFeatureRepository` (tests/dev) | ✅ canonical mutation repository. Its CAS methods protect toggle, verification, and install terminalization state. Internal to the feature context. | [feature-repository.port.ts](../src/features/domain/ports/feature-repository.port.ts) |
| `FeatureSeedConfigPort` (`FEATURE_SEED_CONFIG`) | `FsFeatureSeedConfigAdapter` | ✅ canonical first-install read seam. The seeder treats absent or untrusted input as no verified enabled features. | [feature-seed-config.port.ts](../src/features/domain/ports/feature-seed-config.port.ts) |
| `FeatureInstallJobRepositoryPort` (`FEATURE_INSTALL_JOB_REPOSITORY`) | `DrizzleFeatureInstallJobRepository`, `InMemoryFeatureInstallJobRepository` (tests/dev) | ✅ canonical durable global active-install slot and terminalization boundary. Internal to the feature context. | [feature-install-job.repository.port.ts](../src/features/domain/ports/feature-install-job.repository.port.ts) |
| `FeatureInstallRequestPort` (`FEATURE_INSTALL_REQUEST`) | `FsFeatureInstallRequestAdapter` | ✅ canonical unprivileged spool writer. It publishes only the strict, allowlisted request shape and can cancel only an exact unclaimed request. | [feature-install-request.port.ts](../src/features/domain/ports/feature-install-request.port.ts) |
| `FeatureInstallResultPort` (`FEATURE_INSTALL_RESULT`) | `FsFeatureInstallResultAdapter` | ✅ canonical root-owned result reader. Reconciliation reads bounded, verified state and removes a terminal result only after its database transition commits. | [feature-install-result.port.ts](../src/features/domain/ports/feature-install-result.port.ts) |
| `FeatureInstallControllerPort` (`FEATURE_INSTALL_CONTROLLER`) | `SystemdFeatureInstallControllerAdapter` | ✅ canonical fixed-unit trigger. It starts the root-owned installer asynchronously and exposes no arbitrary command interface. | [feature-install-controller.port.ts](../src/features/domain/ports/feature-install-controller.port.ts) |
| `FeatureClockPort` (`FEATURE_CLOCK`) | `SystemFeatureClockAdapter` | ✅ canonical local clock seam for queueing, reconciliation, and recovery; keeps the feature context independent from the events/system clock ports. | [feature-clock.port.ts](../src/features/domain/ports/feature-clock.port.ts) |
| `FeatureReadinessPort` (`FEATURE_READINESS`) | `FeatureReadinessRouter` over the fixed Digital, UART, Zigbee, Motion, and RTSP adapters; `InMemoryFeatureReadinessAdapter` (tests/dev) | ✅ canonical — each production probe uses fixed executable/argument arrays, a sanitized PATH, a five-second timeout, and a 64 KiB command-output limit. | [feature-readiness.port.ts](../src/features/domain/ports/feature-readiness.port.ts) |
| `FeatureReadinessBarrierPort` (`FEATURE_READINESS_BARRIER`) | `FeatureReadinessBootService` | ✅ canonical boot gate. It performs one shared installed-and-enabled verification pass before availability is published. Internal to the feature context. | [feature-readiness-barrier.port.ts](../src/features/domain/ports/feature-readiness-barrier.port.ts) |
| `FeatureAvailabilityPort` (`FEATURE_AVAILABILITY`) | `FeatureAvailabilityService` | ✅ canonical — published boot-gated state projection. `inspect` and `requireReady` await the shared initial verification pass and derive status from one feature row plus its active install job. | [feature-availability.port.ts](../src/features/domain/ports/feature-availability.port.ts) |
| `FeatureRuntimeLifecyclePort` (registered value; no token) | Per-feature values from `FeatureSensorRuntimeLifecycleService` and `FeatureCameraRuntimeLifecycleService` | ✅ canonical registered runtime work. Each value owns the teardown before disable and reload after enable for exactly one manageable feature. | [feature-runtime-lifecycle.port.ts](../src/features/domain/ports/feature-runtime-lifecycle.port.ts) |
| `FeatureRuntimeLifecycleRegistryPort` (`FEATURE_RUNTIME_LIFECYCLE`) | `FeatureDisableLifecycleRegistry`, with `FeatureSensorRuntimeLifecycleService` and `FeatureCameraRuntimeLifecycleService` registrations | ✅ canonical cross-context runtime seam. `SensorModule` and `CameraModule` register teardown/reload work; Feature use cases invoke it without importing either context. | [feature-runtime-lifecycle.port.ts](../src/features/domain/ports/feature-runtime-lifecycle.port.ts) |
| `FeatureRestartPort` (`FEATURE_RESTART`) | `FixedFeatureRestartAdapter` over `Pm2ProcessRestarter` or `StubProcessRestarter` | ✅ canonical fixed restart-scope dispatcher. A dispatch failure marks only the affected feature `restart-required` after its terminal state has already released the install slot. | [feature-restart.port.ts](../src/features/domain/ports/feature-restart.port.ts) |
| `FeatureInstallOutcomePort` (registered listener; no token) | `FeatureHandler` | ✅ canonical Telegram-side terminal-delivery listener. It is registered through the feature-owned registry, so Feature application code remains independent of Telegram and a delivery failure is best-effort. | [feature-install-outcome.port.ts](../src/features/domain/ports/feature-install-outcome.port.ts) |
| `FeatureInstallOutcomeRegistryPort` (`FEATURE_INSTALL_OUTCOME_REGISTRY`) | `FeatureInstallOutcomeRegistryService`; `FeatureHandler` registers the Telegram delivery listener | ✅ canonical late-bound terminal-delivery seam. Listener failure is caught, so Telegram recovery cannot keep a terminal job active or reintroduce a Feature→Telegram dependency. | [feature-install-outcome.port.ts](../src/features/domain/ports/feature-install-outcome.port.ts) |
| `FeatureDisableLifecyclePort` (`FEATURE_DISABLE_LIFECYCLE`) | `DisableRtspFeatureUseCase` (legacy compatibility seam) | 🚧 retained while the older RTSP disable path is migrated; new feature runtime registration uses `FEATURE_RUNTIME_LIFECYCLE` instead. It is not bound or exported by `FeatureModule`. | [feature-disable-lifecycle.port.ts](../src/features/domain/ports/feature-disable-lifecycle.port.ts) |
| `FeatureDisableLifecycleRegistryPort` (legacy companion; no token) | none bound | 🚧 historical registration shape retained for compatibility only. New composition uses `FeatureRuntimeLifecycleRegistryPort`; do not add consumers here. | [feature-disable-lifecycle.port.ts](../src/features/domain/ports/feature-disable-lifecycle.port.ts) |

### Sensors context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `SensorDriverPort` (`SENSOR_DRIVER_FACTORY`) | `DigitalGpioAdapter`, `UartCo2Adapter`, `MqttSensorAdapter`, `CameraSensorAdapter`, `MockGpioAdapter` (dev), `MockUartCo2Adapter` (dev) | ✅ canonical — env-driven factory in [sensor-driver.factory.ts](../src/sensors/infrastructure/sensor-driver.factory.ts) selects mocks for `NODE_ENV=development`. Lifecycle teardown passes `SensorDriverShutdownContext` (cancellation signal + absolute deadline); adapters become inert before using it to bound transport cleanup. | [sensor-driver.port.ts](../src/sensors/domain/ports/sensor-driver.port.ts) |
| `SensorRepositoryPort` (`SENSOR_REPOSITORY`) | `DrizzleSensorRepository`, `InMemorySensorRepository` (tests) | ✅ canonical | [sensor-repository.port.ts](../src/sensors/domain/ports/sensor-repository.port.ts) |
| `SensorLogRepositoryPort` (`SENSOR_LOG_REPOSITORY`) | `DrizzleSensorLogRepository`, `InMemorySensorLogRepository` (tests) | ✅ canonical — drives buffered UART log flushing, digital GPIO event logging, **and** `/logs` recent-entry queries (`findRecent(sensorId, { limit, since })`). | [sensor-log-repository.port.ts](../src/sensors/domain/ports/sensor-log-repository.port.ts) |
| `SensorLogExportReaderPort` (`SENSOR_LOG_EXPORT_READER`) | `DrizzleSensorLogExportReader`, `InMemorySensorLogExportReader` (tests/dev) | ✅ canonical — bounded synchronous snapshot reader for chronological CSV history export. | [sensor-log-export-reader.port.ts](../src/sensors/domain/ports/sensor-log-export-reader.port.ts) |
| `SensorQueryPort` (`SENSOR_QUERY`) read model for other contexts | `DrizzleSensorQuery`, `InMemorySensorQuery` (tests) | ✅ canonical — `listEnabled`, `findById`, `findByIdIncludingArchived`, and `findByName` (both archive-aware variants support historical `/logs` links). | [sensor-query.port.ts](../src/sensors/domain/ports/sensor-query.port.ts) |
| `SensorHealthPort` (`SENSOR_HEALTH`) | `SensorRegistryService` (live `healthCheck()` per active driver; `online` / `offline` / `missing` / `failed` / `timed_out` results) | ✅ canonical — `/status` and Home refresh use the same bounded `probe(sensorIds, timeoutMs)` port. The registry shares an in-progress physical driver check, while each caller's 5-second Home budget can resolve independently. | [sensor-health.port.ts](../src/sensors/application/ports/sensor-health.port.ts) |
| `GpioBackendPort` (`GPIO_BACKEND`) | `LibgpiodCliBackend` (supervised gpiod CLI subprocesses) | ✅ explicit infrastructure interface + DI token. **Overturns the earlier "keep `PigpioGateway` as a gateway, do not promote" ruling** — deliberately: the interface makes the adapter's test fakes type-checked, and the backend was swapped once already (pigpiod → libgpiod). Placement is infrastructure, not `domain/ports/` — its only consumer is infrastructure and `configure({bias, debounceUs})` is transport vocabulary. | [gpio-backend.port.ts](../src/sensors/infrastructure/gpio-backend.port.ts), [libgpiod-cli.backend.ts](../src/sensors/infrastructure/libgpiod-cli.backend.ts) |
| `SensorResourcesLifecycleAdapter` | (Nest lifecycle owner for `SensorRegistryService`, `LibgpiodCliBackend`, and `MqttConnectionPool`) | ✅ canonical — destroys drivers before closing shared GPIO and MQTT resources; no other sensor resource owns `OnModuleDestroy`. | [sensor-resources-lifecycle.adapter.ts](../src/sensors/infrastructure/sensor-resources-lifecycle.adapter.ts) |

### Events context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `EventRepositoryPort` (`EVENT_REPOSITORY`) | `DrizzleEventRepository`, `InMemoryEventRepository` (tests/dev) | ✅ canonical | [event-repository.port.ts](../src/events/domain/ports/event-repository.port.ts) |
| `NotifierPort` (`NOTIFIER`) | `EventNotifierService` (delegating application adapter), `TelegramNotifierAdapter`, `ConsoleNotifierAdapter` (dev) | 🚧 — Telegram implements the sender, while bot gateway extraction is still pending. Exposes `notify` (broadcast, offline drain), `notifyUser` (per-recipient text, spec 19 filtering) and `notifyUserPhoto` (photo + caption, spec 19/20 motion events). | [notifier.port.ts](../src/events/domain/ports/notifier.port.ts) |
| `RecipientDirectoryPort` (`RECIPIENT_DIRECTORY`) | `RecipientDirectoryService` (application seam; empty until registered), `TelegramRecipientDirectoryAdapter` (registered at bootstrap by `GrammyBotGateway`) | ✅ canonical — read model of who receives notifications (`listRecipients`, `isSensorMuted`). Runtime registration seam avoids the events→telegram import cycle, mirroring `NotifierPort`. | [recipient.port.ts](../src/events/domain/ports/recipient.port.ts) |
| `NotificationOptions` (`NOTIFICATION_OPTIONS`) | factory in `event.module.ts` (timezone from `TIMEZONE` env, default `Europe/Kyiv`) | ✅ canonical — supplies the timezone used for quiet-hours evaluation in `NotificationService`. | [notification-options.port.ts](../src/events/application/ports/notification-options.port.ts) |
| `EventProcessorOptions` (`EVENT_PROCESSOR_OPTIONS`) | `eventProcessorOptionsFromEnv` (reads `EVENT_MAX_CONCURRENCY` / `EVENT_MAX_PENDING`, defaults 4 / 500) | ✅ canonical — bounds active event handling and the raw pre-persistence pending backlog in `EventProcessorService`. | [event-processor-options.port.ts](../src/events/application/ports/event-processor-options.port.ts) |
| `SensorEventSourcePort` (`SENSOR_EVENT_SOURCE`) | `SensorRegistryService` (sensors application layer) | ✅ canonical — events imports the application service via the sensors module. | [sensor-event-source.port.ts](../src/events/domain/ports/sensor-event-source.port.ts) |

### Telegram context

Interactive external workflows use a durable `workflow-return` receipt and the
strict callback grammar `wr:<16-character-base64url-id>:[oh]`: `o` restores the
authorized origin and `h` opens Home. `WorkflowNavigationHandler` is registered
before broad workflow callback handlers. It claims the exact receipt, cancels
only the matching cancellable in-memory draft, and asks
`RestoreWorkflowOriginUseCase` to re-authorize the captured view against the
current role and dynamic data. Running work is never cancelled. The one-release
legacy `rh:<l|c|s|f|i|d|u|a>:<c|r|t>` grammar is acknowledged but non-mutating
and directs the user to localized `/menu` usage only.

| Port | Adapters | Status | Source |
|---|---|---|---|
| `BotGateway` | `GrammyBotGateway` | ✅ single intentional gateway; do not abstract grammY itself further. It acknowledges exact `wr:` and one-release legacy `rh:` callbacks before grammY `sequentialize` constraints for private chat and user, then resolves locale and runs handlers. `WorkflowNavigationHandler` is registered deterministically before broad workflow handlers; `OpenHomeUseCase` remains the only Home-opening authority and always creates fresh Home authority. | [grammy-bot.gateway.ts](../src/telegram/infrastructure/grammy-bot.gateway.ts) |
| `UserRepositoryPort` (`USER_REPOSITORY`) | `DrizzleUserRepository`, `InMemoryUserRepository` (mock/dev/tests) | ✅ canonical — `findByName` is case-insensitive and strips a leading `@`; first-admin claims and final-admin demotion protection are atomic. | [user-repository.port.ts](../src/telegram/domain/ports/user-repository.port.ts) |
| `AdminClaimCredentialPort` (`ADMIN_CLAIM_CREDENTIAL`) | `EnvAdminClaimCredentialAdapter` | ✅ canonical — verifies the setup-generated `CLAIM_ADMIN_TOKEN` without exposing its value. | [admin-claim-credential.port.ts](../src/telegram/domain/ports/admin-claim-credential.port.ts) |
| `InviteCodeRepositoryPort` (`INVITE_CODE_REPOSITORY`) | `DrizzleInviteCodeRepository`, `InMemoryInviteCodeRepository` (mock/tests) | ✅ canonical | [invite-code-repository.port.ts](../src/telegram/domain/ports/invite-code-repository.port.ts) |
| `DirectMessengerPort` (`DIRECT_MESSENGER`) | `TelegramDirectMessenger` (logs in mock mode when no bot is bound) | ✅ canonical — used by `/start`, `/promote`, `/demote` for one-off notifications. | [direct-messenger.port.ts](../src/telegram/domain/ports/direct-messenger.port.ts) |
| `CsvTempFilePort` (`CSV_TEMP_FILE`) | `NodeCsvTempFileAdapter` | ✅ canonical — bounded, worker-owned CSV staging files with explicit disposal and stale-file cleanup. | [csv-temp-file.port.ts](../src/telegram/application/ports/csv-temp-file.port.ts) |
| `HomeSessionStorePort` (`HOME_SESSION_STORE`) | `DrizzleHomeSessionStore` (real), `InMemoryHomeSessionStore` (mock/tests) | ✅ canonical — one durable authority row per `(userId, chatId)`, with active and pending identities. Reservations, promotion, validation, expiry, and close are CAS transitions; a pending reservation expires after 60 seconds. `BOT_MODE=mock` selects the in-memory adapter, otherwise Drizzle. | [home-session-store.port.ts](../src/telegram/domain/ports/home-session-store.port.ts) |
| `HomeActionRepositoryPort` (`HOME_ACTION_REPOSITORY`) | `DrizzleHomeActionRepository` (real), `InMemoryHomeActionRepository` (mock/tests) | ✅ canonical — one bounded current receipt per `(userId, chatId, kind)`. `workflow-return` uses semantic CAS: replacement is atomic; an exact ID may move `pending` → `executing` → `returned`/`completed`, while `claimed`, `resumable`, `returned`, `expired`, `superseded`, and `terminal` distinguish retry/no-op outcomes. Expiry and replacement make stale callbacks harmless. The existing text-backed receipt table is reused; no schema migration is generated. | [home-action-repository.port.ts](../src/telegram/application/ports/home-action-repository.port.ts) |
| `HomeTokenGeneratorPort` (`HOME_TOKEN_GENERATOR`) | `CryptoHomeTokenGenerator` | ✅ canonical — creates a 96-bit (12-byte) base64url token, exactly 16 characters, for every new Home authority. | [home-token-generator.port.ts](../src/telegram/domain/ports/home-token-generator.port.ts) |
| `HomeMessageDeliveryPort` (`HOME_MESSAGE_DELIVERY`) | `TelegramHomeMessageAdapter` (real), `InMemoryHomeMessageDeliveryAdapter` (mock/tests) | ✅ canonical — owns Home send, edit, best-effort deletion of a replaced Home, keyboard stripping for a promotion loser, and transient outcome notices. `BOT_MODE=mock` selects the in-memory adapter; real mode renders through grammY. | [home-message-delivery.port.ts](../src/telegram/application/ports/home-message-delivery.port.ts) |
| `HomeHealthSnapshotPort` (`HOME_HEALTH_SNAPSHOT`) | `InMemoryHomeHealthSnapshotAdapter` (all modes/tests) | ✅ canonical — bounded process-local cache for reporting-health snapshots only; persisted sensor state is always reread. A complete snapshot is fresh for two minutes, and changing enabled IDs makes it insufficient for a normal verdict. | [home-health-snapshot.port.ts](../src/telegram/application/ports/home-health-snapshot.port.ts) |
| `RolePort` | `DrizzleRoleRepository` | 📝 | [role.guard.ts](../src/telegram/guards/role.guard.ts) |

### Archive context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `ArchiveRegistrationPort` (`ARCHIVE_REGISTRATION`) | `RegisterArchiveArtifactUseCase` over `ArchiveArtifactRepositoryPort` | ✅ provider-neutral cross-context artifact registration; callers supply only a validated immutable descriptor and never receive persistence access. | [archive-registration.port.ts](../src/archive/application/ports/archive-registration.port.ts) |
| `ArchiveVerificationPort` (`ARCHIVE_VERIFICATION`) | `VerifyArchiveArtifactUseCase` over exact-ID Google metadata, the immutable manifest, and a bounded local source reader | ✅ current-generation cleanup and private-link gate; every check fails closed on remote drift and local cleanup additionally requires the trusted source's full SHA-256 to remain unchanged. | [archive-verification.port.ts](../src/archive/application/ports/archive-verification.port.ts) |
| `ArchiveRetentionPort` (`ARCHIVE_RETENTION`) | `ApplyDriveRetentionUseCase` over exact-ID retention policy | ✅ cross-context/manual cleanup and quota-recovery boundary; callers supply only the pending byte requirement and an abort signal. | [archive-retention.port.ts](../src/archive/application/ports/archive-retention.port.ts) |
| `DriveArchivePort` (`DRIVE_ARCHIVE`) | `GoogleDriveArchiveAdapter` over the Google SDK metadata API and direct bounded resumable HTTPS gateway | ✅ exact-ID immutable object operations; application code sees only provider-neutral byte iterables and verified metadata, while generated reservations, encrypted sessions, authoritative offsets, and private-object verification remain durable. | [drive-archive.port.ts](../src/archive/application/ports/drive-archive.port.ts) |

### Camera context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `LiveSourceRepositoryPort` (`LIVE_SOURCE_REPOSITORY`) | `DrizzleLiveSourceRepository`, `InMemoryLiveSourceRepository` | ✅ encrypted persistence, metadata-only read model/import, authenticated startup load, transactional key rotation | [live-source-repository.port.ts](../src/camera/domain/ports/live-source-repository.port.ts) |
| `LiveSourceCredentialPort` (`LIVE_SOURCE_CREDENTIAL`) | `AesGcmLiveSourceCredentialAdapter`, fail-closed unavailable adapter | ✅ versioned AES-256-GCM with camera/version AAD and transactional repository rotation | [live-source-credential.port.ts](../src/camera/domain/ports/live-source-credential.port.ts) |
| `LiveSourceProbePort` (`LIVE_SOURCE_PROBE`) | `FfmpegLiveSourceProbeAdapter`, fail-closed unavailable adapter | ✅ DNS-all-answer/CIDR validation, exact temporary egress lease, bounded Unix-socket FFmpeg probe | [live-source-probe.port.ts](../src/camera/domain/ports/live-source-probe.port.ts) |
| `RtspRuntimeCoordinatorPort` (`RTSP_RUNTIME_COORDINATOR`) | `FfmpegLiveSourceProbeAdapter`, fail-closed unavailable adapter | ✅ shared restricted DNS, egress, sandbox, deadline, and cleanup orchestration for probe and live conversion | [rtsp-runtime-coordinator.port.ts](../src/camera/domain/ports/rtsp-runtime-coordinator.port.ts) |
| `RtspStreamRuntimePort` (`RTSP_STREAM_RUNTIME`) | `RestrictedRtspStreamRuntimeAdapter`, fail-closed unavailable adapter | ✅ loads RTSP credentials only at converter start and exposes a secret-free opaque lifecycle | [rtsp-stream-runtime.port.ts](../src/camera/domain/ports/rtsp-stream-runtime.port.ts) |
| `LiveSourceSessionControlPort` (`LIVE_SOURCE_SESSION_CONTROL`) | `LiveStreamSessionControlAdapter` | ✅ conservatively stops the one global live session before source removal | [live-source-session-control.port.ts](../src/camera/domain/ports/live-source-session-control.port.ts) |
| `StreamSandboxPort` (`STREAM_SANDBOX`) | `SystemdFfmpegStreamAdapter`, fail-closed unavailable adapter | ✅ fixed UUID systemd control, gateway-prepared private Unix-socket output, bounded process identity/status | [stream-sandbox.port.ts](../src/camera/domain/ports/stream-sandbox.port.ts) |
| `StreamEgressPort` (`STREAM_EGRESS`) | `NftStreamEgressAdapter`, fail-closed unavailable adapter | ✅ authenticated local helper with replay-safe, expiring UID-scoped RTSP/RTP egress leases | [stream-egress.port.ts](../src/camera/domain/ports/stream-egress.port.ts) |
| `MotionControlPort` (`MOTION_CONTROL`) | `MotionDaemonAdapter` (systemctl, incl. `restart()`), `StubMotionControlAdapter` (dev) | ✅ | [motion-daemon.adapter.ts](../src/camera/infrastructure/motion-daemon.adapter.ts) |
| `LocalStoragePort` (`LOCAL_STORAGE`) | `FsLocalStorageAdapter` (`df -P` + fs delete/prune), `StubLocalStorageAdapter` (dev) | ✅ disk usage + local cleanup (spec 21) | [local-storage.port.ts](../src/camera/domain/ports/local-storage.port.ts) |
| `RetentionPrunePort` (`RETENTION_PRUNE`) | `DrizzleRetentionPruneAdapter` (emergency events/sensor-log prune), `StubRetentionPruneAdapter` (dev) | ✅ emergency disk recovery (spec 21) | [retention-prune.port.ts](../src/camera/domain/ports/retention-prune.port.ts) |
| `DbBackupPort` (`DB_BACKUP`) | `SqliteDbBackupAdapter` (SQLite online backup), `StubDbBackupAdapter` (dev) | ✅ daily DB backup (spec 21) | [db-backup.port.ts](../src/camera/domain/ports/db-backup.port.ts) |
| `MediaRepositoryPort` (`MEDIA_REPOSITORY`) | `DrizzleMediaRepository`, `InMemoryMediaRepository` (dev) | ✅ read model | [drizzle-media.repository.ts](../src/camera/infrastructure/drizzle-media.repository.ts) |
| `MediaWriterPort` (`MEDIA_WRITER`) | `DrizzleMediaRepository`, `InMemoryMediaRepository` (dev) — same instance, aliased | ✅ write side for motion hooks (spec 20) | [media-writer.port.ts](../src/camera/domain/ports/media-writer.port.ts) |
| `CompletedMotionVideoPort` (`COMPLETED_MOTION_VIDEO`) | `FsCompletedMotionVideoAdapter` | ✅ exact-root, no-follow Motion video validation with 60-second stability and bounded streaming SHA-256 before archive registration. | [completed-motion-video.port.ts](../src/camera/domain/ports/completed-motion-video.port.ts) |
| `SnapshotPort` (`SNAPSHOT`) | `FfmpegSnapshotAdapter` (caches via TTL), `StubSnapshotAdapter` (dev) | ✅ | [snapshot.port.ts](../src/camera/domain/ports/snapshot.port.ts) |
| `MotionAlertPort` (`MOTION_ALERT`) | `EventsMotionAlertAdapter` (delegates to events `NotificationService`), `StubMotionAlertAdapter` (dev) | ✅ motion notification (spec 19, 20) | [motion-alert.port.ts](../src/camera/domain/ports/motion-alert.port.ts) |
| `AdminAlertPort` (`ADMIN_ALERT`) | `AdminAlertService` (register/clear seam) ← `TelegramAdminAlertAdapter` registered at bot bootstrap | ✅ daemon up/down and emergency-disk alerts (specs 20, 21) | [admin-alert.port.ts](../src/camera/domain/ports/admin-alert.port.ts) |
| `LiveStreamMessageCleanupPort` (`LIVE_STREAM_MESSAGE_CLEANUP`) | `NoopLiveStreamMessageCleanupAdapter` (interim); Telegram adapter pending Task 5 | 🚧 application-owned seam for best-effort expiry/stop cleanup; the no-op keeps recovery DI complete until Telegram owns deletion | [live-stream-message-cleanup.port.ts](../src/camera/domain/ports/live-stream-message-cleanup.port.ts) |
| `LiveStreamCapabilityPort` (`LIVE_STREAM_CAPABILITY`) | `FeatureLiveStreamCapabilityAdapter`, `AvailableLiveStreamCapabilityAdapter` (stub/dev) | ✅ explicit env + installed/enabled feature + cloudflared executable gate before source or gateway startup | [live-stream-capability.port.ts](../src/camera/domain/ports/live-stream-capability.port.ts) |
| `LiveStreamGatewayPort` (`LIVE_STREAM_GATEWAY`) | `QuickTunnelLiveStreamAdapter`, `InMemoryLiveStreamGatewayAdapter` (dev/test) | ✅ token-gated Motion/RTSP MJPEG fan-out, gateway-owned Unix producer socket, and owned Quick Tunnel lifecycle | [live-stream-gateway.port.ts](../src/camera/domain/ports/live-stream-gateway.port.ts) |
| `LiveStreamLeasePort` (`LIVE_STREAM_LEASE`) | `FsLiveStreamLeaseAdapter`, `InMemoryLiveStreamLeaseAdapter` (dev/test) | ✅ atomic private runtime recovery lease | [live-stream-lease.port.ts](../src/camera/domain/ports/live-stream-lease.port.ts) |
| `MonotonicClockPort` (`MONOTONIC_CLOCK`) | `SystemMonotonicClockAdapter`, `InMemoryMonotonicClockAdapter` (stub/dev), fixed test clocks | ✅ camera live-session expiry independent of wall-clock changes | [monotonic-clock.port.ts](../src/camera/domain/ports/monotonic-clock.port.ts) |

### System context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `SystemHealthPort` (`SYSTEM_HEALTH`) | `OsSystemHealthAdapter` (`df -kP`, `/sys/class/thermal`, `process.memoryUsage`, `os.totalmem`, `process.uptime`, `fs.stat` on `DATABASE_PATH`) | ✅ canonical — drives `/health`. Disk / CPU temp / db size degrade to `null` on dev hosts without throwing. | [system-health.port.ts](../src/system/domain/ports/system-health.port.ts) |
| `ApplicationLogReaderPort` (`APPLICATION_LOG_READER`) | `Pm2ApplicationLogReaderAdapter`; `InMemoryApplicationLogReaderAdapter` (tests/dev) | ✅ bounded, sanitized, read-only PM2 output/error snapshots for the admin Telegram boundary | [application-log-reader.port.ts](../src/system/domain/ports/application-log-reader.port.ts) |

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
| `TimezoneOptions` (`TIMEZONE_OPTIONS`) | `ConfigModule` (binds `timezoneOptionsFromEnv`) | ✅ canonical — shared resolved IANA timezone for event scheduling and CSV timestamps. | [timezone-options.port.ts](../src/config/application/ports/timezone-options.port.ts) |
| `ConfigPort` | `YamlConfigLoader` | 🚧 | [config.loader.ts](../src/config/config.loader.ts) |
| `LoggerPort` | (use Nest `Logger` for now) | ✅ — Nest's `Logger` is the contract; do not invent a wrapper. |

## Rules

1. **One port per cross-boundary concept.** Not one port per class.
2. **A port is owned by the context that calls it**, not the one that implements it. `NotifierPort` lives under `events/domain/ports/`, even though Telegram implements it.
3. **Single-implementation infrastructure utilities** (Motion daemon wrapper) stay as gateways — *not* every external dependency needs an interface. The cost is paid only when (a) we want to mock for tests **or** (b) we expect to swap the tech. The former pigpio gateway is the worked example of cost (b) coming due: it was promoted to `GpioBackendPort` when the tech was swapped.
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
