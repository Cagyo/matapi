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

RTSP install and verification cross the privilege boundary through exactly one
root-owned executable, `/usr/lib/home-worker/live-stream-policy-inspector`. Its
contract is closed: `discover` and `verify-installed` only — no paths,
interfaces, CIDRs, or environment overrides — and any other argv exits `2`
without spawning anything. `RtspPolicyInspectorGateway` is the worker's only
channel to it (fixed argv, sanitized environment, five-second timeout, 64 KiB
output cap); it discards raw stdout and stderr rather than carrying them into a
log line or an error message. Only the redacted verdict crosses into the
application: `ready`, one of the closed reasons `local-network-unavailable`,
`policy-stale`, or `policy-summary-invalid`, the installed digest when it is
safely available, and the interface/CIDR projection. The private policy file,
the UID inventory, and the environment never do.

`verify-installed` re-discovers the live interfaces on every call and compares
them to the installed projection. The digest — SHA-256 over compact sorted-key
JSON of schema version, worker UID, stream UID, the interface/CIDR pairs, and
the UDP range, ordered by family, network bytes, prefix length, then interface
name — proves only that the three durable artifacts still agree with each
other. It never proves the policy still matches the network, so a digest that
still compares equal is not evidence of freshness on its own.

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
| `FeatureReadinessPort` (`FEATURE_READINESS`) | `FeatureReadinessRouter` over the fixed Digital, UART, Zigbee, Motion, and RTSP adapters; `InMemoryFeatureReadinessAdapter` (tests/dev) | ✅ canonical — each production probe uses fixed executable/argument arrays, a sanitized PATH, a five-second timeout, and a 64 KiB command-output limit. A refusal carries one reason: `runtime-group-incomplete` (the only one another restart can fix), `policy-stale`, or `runtime-invalid`. `RtspReadinessAdapter` takes its last check from the shared `RTSP_POLICY_STATUS` instance instead of reading the policy artifacts itself. | [feature-readiness.port.ts](../src/features/domain/ports/feature-readiness.port.ts) |
| `RtspPolicyStatusPort` (`RTSP_POLICY_STATUS`) | `InstalledRtspPolicyStatusAdapter` over `RtspPolicyInspectorGateway` | ✅ canonical single verified projection of the installed RTSP policy, exported by `FeatureModule` so no consumer opens the policy artifacts itself. It reads the public summary through one no-follow single-link root-owned exact-mode descriptor, recomputes the digest field by field, requires the digest, CIDR list, and UDP range this process was started with to agree with it, and only then asks the inspector whether the installed networks are still the live ones. `inspect` degrades to `unavailable`, `requireCurrent` throws, and `assertDigest` is the synchronous fence over the last digest actually proven current. **Load-bearing for Camera:** `inspect` runs `assertEnvironmentAgrees(installed)` *before* it returns either `ready` or `stale`, and fails closed to `unavailable` on any drift, so a `ready` status's `digest` and `networks` provably describe the same `RTSP_ALLOWED_CIDRS` string the probe parses. That is what bounds the status/enforcement divergence in Camera (below) to two arithmetic rules over one policy vocabulary rather than two unrelated sources. (A `stale` status deliberately returns the inspector's freshly *discovered* networks instead — that difference is the drift being reported — and Camera marks `currentPolicyDigest` null for it, so nothing is ever reported verified against them.) | [rtsp-policy-status.port.ts](../src/features/domain/ports/rtsp-policy-status.port.ts) |
| `FeatureProcessIdentityPort` (`FEATURE_PROCESS_IDENTITY`) | `LinuxFeatureProcessIdentityAdapter` | ✅ canonical `<linux-boot-id>:<proc-self-start-ticks>` identity, read from bounded fixed `/proc` paths with `/proc/self/stat` parsed from its final `)`. Both halves are required — start ticks repeat across boots, and the boot id survives every restart within one boot. It is what makes an `awaiting-restart` install verifiable only by a genuinely fresh process. | [feature-process-identity.port.ts](../src/features/domain/ports/feature-process-identity.port.ts) |
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

The RTSP camera-source conversation asks an administrator to paste an address
that carries a camera password, so its durable state is credential-free by
construction and its Telegram message is deleted before the address is used.
Two ports own those halves: `CAMERA_SOURCE_PROMPT_REPOSITORY` (what is
remembered) and `CAMERA_SOURCE_MESSAGE` (what is deleted). A prompt row carries
identities, a non-secret camera selection and lifecycle bookkeeping — nothing
else. `assertCameraSourcePrompt` enforces an **exact key set**, so
`{ ...prompt, url: SECRET }` cannot reach either adapter, and every rejection
reason is a static string because the value it refused is exactly what might be
a credential.

The ten-minute window is unforgeable rather than merely enforced.
`createCameraSourcePrompt` takes `createdAt` and **never** `expiresAt` — there
is no parameter through which a different window could be expressed — and it
refuses an input that carries any lifecycle field the model owns.

**Exact-reply CAS.** `claimReply` is the single `pending → running` transition
on one user/chat/receipt/prompt-message identity, so exactly one reply can ever
authorise an install. `now === expiresAt` is already late. A `late` answer still
carries the prompt, because a late credential reply must be *deleted* rather
than acted on; an identity nothing is stored under answers `stale`. The terminal
transitions take an **identity, not a whole prompt** — `consume`/`expire` accept
`{ identity, deletionFailed, now }`, so a caller holding only callback data
never fabricates a prompt to end one, and the stored row stays the only
authority on its own contents. Both are idempotent, neither overwrites the first
terminal status or its retention deadline, and `deletionFailed` is sticky
(`||`): a standing failure is never cleared by a later clean deletion.

**Tombstones hold no secret.** A terminal *credential* prompt is retained for 24
hours measured from its **first** terminal transition, so a late reply can still
be deleted, and only the newest 100 tombstones per administrator survive. A
*name* prompt is deleted outright — a camera name is not a secret and there is
nothing to keep. `prune` has three predicated arms: tombstones past retention,
abandoned `pending` rows, and `running` rows past the abandonment horizon (the
backstop for rows `listRunning` drops as undecodable). Nothing is exempt from
every arm, so no row is immortal, and no arm is a full-table sweep.
`CAMERA_SOURCE_ABANDONED_TTL_MS` is a separate constant from the tombstone TTL:
both start at 24 hours and measure different things — retention exists so a late
reply can still be cleaned up, abandonment exists because Telegram stops letting
a bot delete a message after roughly 48 hours.

`expires_at` and `retain_until` are stored as `timestamp_ms` while every other
Date column in the schema uses seconds. Deliberate: the window is a promise
about an instant, and the two adapters must not be able to disagree on
sub-second precision.

**Startup deletion recovery.** A `running` row means a process died between
claiming a credential reply and deleting it, so the credential is still sitting
in the chat. `RecoverCameraSourcePromptsUseCase` finishes that cleanup on boot,
**before `run(bot)`** opens the update pump — a live reply handler must not
reach `claimReply` on a row already inside recovery's `listRunning` snapshot —
and fire-and-forget, so an unreachable Telegram cannot hold the whole worker out
of service. It `expire`s **every** row `listRunning` returns regardless of
phase, attempting a deletion only for a credential row with a recorded reply, so
nothing is left `running` for later boots to skip. Each **row** is isolated, not
just each deletion: the result is `{ attempted, failed, unfinished }`, where
`failed` is deletion-scoped and `unfinished` counts rows the repository refused
to terminalise. Mock mode neither arms the message adapter nor runs recovery.

**A prompt whose workflow ends must be retracted, not merely forgotten.**
`CameraSourcesHandler.retractPending` is the only supported way to stop a prompt
being answerable, and the routing is dropped only once the message is provably
gone. When Telegram refuses the deletion the prompt is still armed in the chat,
so its routing is deliberately restored: `claimReply` then answers `late`, the
reply is deleted as cleanup, and nothing is installed. The failure this prevents
is the opposite order — forgetting the routing while the ForceReply is still
live, after which a credential answered into it reaches the next handler
undeleted.

**Screens and routing are keyed differently, on purpose.**
`CameraSourceViewStore` remembers navigation only — a receipt, the page last
rendered, the opaque selector opened, and the revision that detail was read at —
and every entry is expendable, costing one reload. Screen states are keyed by
receipt and superseded by the next screen of the same workflow; a **prompt is
keyed by its own message id**, because it must stay answerable until it is
retracted or expires, which is a different lifetime from the screen that opened
it.

**Deletion-before-effect is a data dependency, not an ordering convention.**
`takeAddressAndDelete` produces a `CredentialReply` and `install` is the only
thing that consumes one, so an address cannot exist in the handler without a
deletion having been attempted first. A `finally` retries the deletion once, and
only when the first attempt failed.

**Revision fencing uses two mechanisms deliberately.** Replace stores
`expectedRevision` on the durable prompt row, because the address arrives in a
later update and possibly after a restart; remove carries it in the callback
itself — `rm:y:<selector>:<revision>` — because the confirmation screen is the
thing being fenced.

**One rule decides what runs ahead of the readiness gate:** an action that
**ends** or **repairs** the unusable state runs ahead of it; everything that
reads or mutates a source runs behind it. Today that is reinstall (an
administrator reaches for it *because* RTSP is unusable) and cancel (RTSP can
become unusable underneath an armed ForceReply, and behind the gate a cancel
would render the feature notice and leave the prompt with no control that ends
it). A third candidate is decided by that sentence, not by those two precedents.

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
| `CameraSourcePromptRepositoryPort` (`CAMERA_SOURCE_PROMPT_REPOSITORY`) | `DrizzleCameraSourcePromptRepository` (real), `InMemoryCameraSourcePromptRepository` (mock/tests) | ✅ canonical durable state for one exact-reply RTSP credential prompt, and credential-free by construction. `claimReply` is the single `pending → running` compare-and-set on the exact user/chat/receipt/prompt-message identity; `consume`/`expire` are idempotent terminal transitions taking an **identity**, not a prompt; `listRunning` feeds boot recovery oldest-deadline first; `prune` sweeps tombstones and abandoned rows through three predicated arms. Both adapters are held to one `describe.each` contract table (`describeCameraSourcePromptContract`), and both carry dates at millisecond precision. `BOT_MODE=mock` selects the in-memory adapter, otherwise Drizzle. | [camera-source-prompt-repository.port.ts](../src/telegram/application/ports/camera-source-prompt-repository.port.ts) |
| `CameraSourceMessagePort` (`CAMERA_SOURCE_MESSAGE`) | `TelegramCameraSourceMessageAdapter` (all modes; armed with the bot by `GrammyBotGateway`) | ✅ canonical deletion of one credential-bearing reply, by `(chatId, messageId)` alone — a prompt carries a receipt and a proposed camera name, and none of that has any business reaching a Telegram API call. **Fails closed**, deliberately unlike `LiveStreamMessageCleanupPort`: it rejects rather than resolving when there is no bot, so a caller is never told "deleted" about a credential still sitting in a chat. It never re-throws grammY's error — only the parameterless `CameraSourceMessageDeletionError` leaves the class ([error-handling.md](error-handling.md#camera-source-prompt-deletion)). | [camera-source-message.port.ts](../src/telegram/application/ports/camera-source-message.port.ts) |
| `RolePort` | `DrizzleRoleRepository` | 📝 | [role.guard.ts](../src/telegram/guards/role.guard.ts) |

### Archive context

| Port | Adapters | Status | Source |
|---|---|---|---|
| `ArchiveRegistrationPort` (`ARCHIVE_REGISTRATION`) | `RegisterArchiveArtifactUseCase` over `ArchiveArtifactRepositoryPort` | ✅ provider-neutral cross-context artifact registration; callers supply only a validated immutable descriptor and never receive persistence access. | [archive-registration.port.ts](../src/archive/application/ports/archive-registration.port.ts) |
| `ArchiveVerificationPort` (`ARCHIVE_VERIFICATION`) | `VerifyArchiveArtifactUseCase` over exact-ID Google metadata, the immutable manifest, and a bounded local source reader | ✅ current-generation cleanup and private-link gate; every check fails closed on remote drift and local cleanup additionally requires the trusted source's full SHA-256 to remain unchanged. | [archive-verification.port.ts](../src/archive/application/ports/archive-verification.port.ts) |
| `ArchiveRetentionPort` (`ARCHIVE_RETENTION`) | `ApplyDriveRetentionUseCase` over exact-ID retention policy | ✅ cross-context/manual cleanup and quota-recovery boundary; callers supply only the pending byte requirement and an abort signal. | [archive-retention.port.ts](../src/archive/application/ports/archive-retention.port.ts) |
| `DriveArchivePort` (`DRIVE_ARCHIVE`) | `GoogleDriveArchiveAdapter` over the Google SDK metadata API and direct bounded resumable HTTPS gateway | ✅ exact-ID immutable object operations; application code sees only provider-neutral byte iterables and verified metadata, while generated reservations, encrypted sessions, authoritative offsets, and private-object verification remain durable. | [drive-archive.port.ts](../src/archive/application/ports/drive-archive.port.ts) |
| `DriveFolderPort` (`DRIVE_FOLDER`) | `GoogleDriveFolderAdapter` | ✅ canonical exact-ID boundary for private Motion year/month/day folders. Candidate discovery is bounded and paginated; create/read results must match the requested generated ID and immutable app properties. | [drive-folder.port.ts](../src/archive/application/ports/drive-folder.port.ts) |
| `DriveFolderReservationRepositoryPort` (`DRIVE_FOLDER_RESERVATION_REPOSITORY`) | `DrizzleDriveFolderReservationRepository` (production), `InMemoryDriveFolderReservationRepository` (tests) | ✅ canonical append-only date-folder authority. One revision-fenced current reservation exists per generation/path; replacement releases the current slot without deleting audit history, and detached/conflict branches stay blocked. | [drive-folder-reservation-repository.port.ts](../src/archive/application/ports/drive-folder-reservation-repository.port.ts) |
| `ArchiveProviderStateRepositoryPort` (`ARCHIVE_PROVIDER_STATE_REPOSITORY`) | `DrizzleArchiveProviderStateRepository` (production), `InMemoryArchiveProviderStateRepository` (tests) | ✅ canonical singleton CAS state for generation-scoped Drive cooldown, probe, quota, capacity, policy, and reauthorization admission. Activating a generation clears stale state from the previous generation. | [archive-provider-state-repository.port.ts](../src/archive/application/ports/archive-provider-state-repository.port.ts) |
| `ArchiveRuntimeSignalPort` (`ARCHIVE_RUNTIME_SIGNAL`) | `ArchiveSchedulerService` (`useExisting`) | ✅ published Camera→Archive progress seam. A completed Motion traversal monotonically CAS-updates scheduler progress and wakes the single-flight drain pump without exposing Archive persistence or Google adapters. | [archive-runtime-signal.port.ts](../src/archive/application/ports/archive-runtime-signal.port.ts) |

### Camera context

Every RTSP camera-source mutation runs through `RtspSourceMutationService`, so
the ordering that makes it safe is written once. An **install** — create,
attach, replace — captures the policy digest, the `RtspSourceStartGate` epoch
and the stored revision before it probes, then re-checks all of them plus the
actor's role immediately before a synchronous commit:

```
requireAdmin → requireReady('rtsp') → requireCurrent → snapshot(epoch)
  → requireStoredRevision → probe → encrypt
  → requireReady('rtsp') → requireCurrent → stopCamera   (replace only)
  ──────────── FENCE: no await below this line ────────────
  → requireAdmin → assertEpoch → assertDigest → assertSameDigest → commit
```

`stopCamera` is the **last** await rather than an earlier step: a user-initiated
`OpenLiveStreamUseCase` moves no gate epoch, so a converter started after the
stop is invisible to every fence below it and the swap would land while the old
URL was still streaming. Putting the stop last narrows that window from two
I/O-bound awaits to one microtask boundary, in which only an already-queued
start can be admitted and none can complete. It does **not** close it — full
closure needs a per-camera lease, which is a follow-up.

`assertEpoch` is the complete fence: it throws when the epoch moved **and** when
the gate is closed right now, so a caller needs no separate `assertCanStart`.

**`remove` is deliberately not uniform.** It runs `requireAdmin →
requireStoredRevision → stopCamera → (sync) requireAdmin → commit`, dropping
`requireReady` ×2, `requireCurrent` ×2, `assertDigest`, `assertSameDigest` and
`assertGateOpen`. Removal probes nothing, encrypts nothing and persists no
digest — its port signature takes only `{ cameraId, expectedRevision }` — and
the policy installer never touches `cameras` or `camera_live_sources`, so those
gates protect nothing while creating an indefinite lock-out: on a network where
the policy inspector finds no eligible physical interface a reinstall can never
complete, and an admin could then never remove a source. The stop fence is a
conscious keep, not an oversight: a wedged converter refuses removal with
`session-stop-failed` after the session service's 30-second operation timeout,
which beats deleting a row while it is still being streamed. Do not "restore
consistency" here — that reintroduces the lock-out.

Rows created by `RTSP_SOURCE_CONFIGURATION` carry `cameras.type =
RTSP_SOURCE_CAMERA_TYPE`, which is `'rtsp-source'` and **not** `'rtsp'`:
`config/dev-state.yml` already ships a hand-written `type: rtsp` camera, and
reusing that word would let `remove()` delete an operator's camera outright.
`camera_live_sources.verified_at` is Unix epoch **milliseconds**, matching its
`created_at`/`updated_at` siblings — not Drizzle's `{ mode: 'timestamp' }`,
which stores seconds.

Status is credential-free by construction. `GetRtspSourceOverviewUseCase` reads
the redacted repository projection plus `RTSP_POLICY_STATUS.inspect()` and hands
`LIVE_SOURCE_POLICY_EVALUATOR` the source's credential-free *hosts* — never a
URL — so it never calls `loadForStream` and never decrypts. The `relationship`
it reports is a **display value and never an authorization input**: enforcement
is the probe's own containment check plus the installed packet policy, both of
which run in full regardless. Three CIDR implementations now exist — the probe's
(enforcement), the evaluator's (status), and `installed-rtsp-policy-status`'s
own `canonicalNetwork`/`contains`/`addressValue` (different prefix floor, plus a
private-range allowlist). Two known divergences remain between the first two,
both fail-safe in the same direction (status more permissive than enforcement,
never the reverse), pinned row by row in
[rtsp-policy-containment.contract.test.ts](../test/camera/infrastructure/rtsp-policy-containment.contract.test.ts).
Extracting one `PolicyNetworkSet` value object over all three is the deferred
follow-up.

> **Reachable end to end.** `CameraSourcesHandler` is the single Telegram
> consumer of these use cases: Add routes to `CreateRtspCameraUseCase` (create)
> or `AttachRtspSourceUseCase` (attach to an existing camera), and the detail
> screen routes to `TestRtspSourceUseCase`, `ReplaceRtspSourceUseCase` and
> `RemoveRtspSourceUseCase`. `ConfigureLiveSourceUseCase` — which resolved a
> camera by name and threw `CameraNotFoundError` for a name that did not yet
> exist — is no longer on that path; it is still provided and exported by
> `CameraModule`, and covered by its own tests, but nothing in `src/` calls it
> any more; retiring it is a follow-up.

| Port | Adapters | Status | Source |
|---|---|---|---|
| `LiveSourceRepositoryPort` (`LIVE_SOURCE_REPOSITORY`) | `DrizzleLiveSourceRepository`, `InMemoryLiveSourceRepository` | ✅ encrypted persistence, metadata-only read model/import, authenticated startup load, transactional key rotation. `findRedacted(cameraId)` is the credential-free single-source lookup the mutation fence reads revisions from, and `RedactedLiveSource` carries `hasCredential`, `revision`, `verifiedAt` (epoch ms) and `policyDigest`. There is deliberately **no** `remove(cameraId)`: it was a non-CAS deletion path, and retiring a source is now a fenced compare-and-swap owned by `RTSP_SOURCE_CONFIGURATION`. | [live-source-repository.port.ts](../src/camera/domain/ports/live-source-repository.port.ts) |
| `LiveSourceCredentialPort` (`LIVE_SOURCE_CREDENTIAL`) | `AesGcmLiveSourceCredentialAdapter`, fail-closed unavailable adapter | ✅ versioned AES-256-GCM with camera/version AAD and transactional repository rotation | [live-source-credential.port.ts](../src/camera/domain/ports/live-source-credential.port.ts) |
| `LiveSourceProbePort` (`LIVE_SOURCE_PROBE`) | `FfmpegLiveSourceProbeAdapter`, fail-closed unavailable adapter | ✅ DNS-all-answer/CIDR validation, exact temporary egress lease, bounded Unix-socket FFmpeg probe | [live-source-probe.port.ts](../src/camera/domain/ports/live-source-probe.port.ts) |
| `RtspRuntimeCoordinatorPort` (`RTSP_RUNTIME_COORDINATOR`) | `FfmpegLiveSourceProbeAdapter`, fail-closed unavailable adapter | ✅ shared restricted DNS, egress, sandbox, deadline, and cleanup orchestration for probe and live conversion | [rtsp-runtime-coordinator.port.ts](../src/camera/domain/ports/rtsp-runtime-coordinator.port.ts) |
| `RtspStreamRuntimePort` (`RTSP_STREAM_RUNTIME`) | `RestrictedRtspStreamRuntimeAdapter`, fail-closed unavailable adapter | ✅ loads RTSP credentials only at converter start and exposes a secret-free opaque lifecycle | [rtsp-stream-runtime.port.ts](../src/camera/domain/ports/rtsp-stream-runtime.port.ts) |
| `LiveSourceSessionControlPort` (`LIVE_SOURCE_SESSION_CONTROL`) | `LiveStreamSessionControlAdapter` over `LiveStreamSessionService` | ✅ scoped stops, not a global one. `stopCamera(cameraId)` stops the active, pending and queued-replacement work of exactly one camera — other cameras keep streaming — and `stopSourceKind(kind)` stops one source kind. Both are idempotent and safe for a camera with no session. This **replaces** the former global `stopActiveSession()`. | [live-source-session-control.port.ts](../src/camera/domain/ports/live-source-session-control.port.ts) |
| `CameraSourceAuthorizationPort` (`CAMERA_SOURCE_AUTHORIZATION`) | `CameraSourceAuthorizationRegistry` (`useExisting`) ← `TelegramCameraSourceAuthorizationAdapter`, registered by `TelegramModule` | ✅ **synchronous** `requireAdmin(userId): void` — the final fence in front of a synchronous better-sqlite3 transaction, so it cannot await. Late-bound through the registry so `CameraModule` never imports Telegram, and **fail-closed before registration**: every actor is denied until an authority registers, so a composition mistake cannot become a silently unguarded mutation. The adapter re-reads the role from SQLite on *every* call (a member demoted between the pre-probe check and the fence is denied by the second call) and denies on an unreadable table. Only the verdict crosses; a denial carries no actor identity. | [camera-source-authorization.port.ts](../src/camera/domain/ports/camera-source-authorization.port.ts) |
| `RtspSourceConfigurationPort` (`RTSP_SOURCE_CONFIGURATION`) | `DrizzleRtspSourceConfigurationAdapter`, `InMemoryRtspSourceConfigurationAdapter` (stub/dev/tests, writing through the shared in-memory repositories) | ✅ every camera/source/credential mutation as one **synchronous** `db.transaction` — `createCamera`, `attach`, `replace`, `remove`. Synchronous on purpose: no `await` may sit between the caller's final checks and the write, so do not make a method `async` or return a promise. The provider factory awaits `backfillNameKeys()` before handing the port out, so no mutation can precede the one-time canonical-name backfill. The adapter itself performs no encryption, probing, DNS or authorization. | [rtsp-source-configuration.port.ts](../src/camera/domain/ports/rtsp-source-configuration.port.ts) |
| `CameraIdGeneratorPort` (`CAMERA_ID_GENERATOR`) | `CryptoCameraIdGeneratorAdapter` | ✅ mints the opaque identifier a new RTSP camera is stored under, never derived from a display name. A port so a caller that hits `CameraIdCollisionError` can retry with a fresh value, and so tests can inject a deterministic sequence. | [camera-id-generator.port.ts](../src/camera/domain/ports/camera-id-generator.port.ts) |
| `CameraClockPort` (`CAMERA_CLOCK`) | `SystemCameraClockAdapter`, fixed clocks in tests | ✅ **synchronous** wall clock for the `verifiedAt` attestation, stamped inside the fence where no `await` is permitted. Distinct from `MONOTONIC_CLOCK`, which measures elapsed time and cannot be stored. | [camera-clock.port.ts](../src/camera/domain/ports/camera-clock.port.ts) |
| `LiveSourcePolicyEvaluatorPort` (`LIVE_SOURCE_POLICY_EVALUATOR`) | `SystemLiveSourcePolicyEvaluatorAdapter` | ✅ credential-free status projection: given the source's hosts and the installed networks it answers `allowed` / `blocked` / `unresolved`, worst-first across primary and substream, resolving on every call rather than caching. **Never an authorization input** — see the note above. Cost model: hosts are deduplicated *after* parsing, so a primary/substream pair differing only by port (`cam.local:554` / `cam.local:8554`) costs one lookup; the overview resolves only the visible page, and does so in waves of `RTSP_SOURCE_OVERVIEW_RESOLUTION_WAVE = 4` — the libuv threadpool default — because a full 20-row page × 2 hosts would otherwise queue 40 `dns.lookup` calls against 4 slots and let later rows spend their whole 5-second budget waiting, marking healthy cameras `needs-attention` without the resolver ever being asked. | [live-source-policy-evaluator.port.ts](../src/camera/domain/ports/live-source-policy-evaluator.port.ts) |
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
