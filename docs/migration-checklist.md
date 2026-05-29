# Hexagonal Migration Checklist

> **Dependencies:** [architecture.md](architecture.md), [ports-and-adapters.md](ports-and-adapters.md), [dependency-injection.md](dependency-injection.md), [testing.md](testing.md).

This checklist is based on a scan of `src/` on 2026-05-28. It is a planning artifact, not a demand for a big-bang rewrite. Follow the policy in [architecture.md](architecture.md#migration-policy): enforce hexagonal architecture for new code and migrate existing files when they are meaningfully touched.

## Scan Summary

33 TypeScript files were scanned across these contexts:

| Context | Current files | Main migration pressure |
|---|---:|---|
| app/bootstrap | 2 | PID lock and process lifecycle live in bootstrap code |
| database | 3 | One central Drizzle schema owns tables for every context |
| config | 1 | YAML config is a module-level function instead of a port-backed adapter |
| sensors | 19 | Hexagonal split complete; `SensorQueryPort` still pending for telegram. |
| events | 3 | Queue service mixes application behavior with Drizzle persistence |
| telegram | 8 | Commands and guards query Drizzle directly; grammY handlers own use-case logic |
| camera | 4 | Stubs are service-shaped but should become ports and adapters before implementation |
| network | 2 | Heartbeat scheduling, fetch I/O, env reads, and service lifecycle are combined |
| locales | 1 | Correctly isolated as user-facing interface strings |

## Migration Order

1. [ ] Add missing boundary tests and in-memory adapters only when a context is touched.
2. [ ] Migrate `events` first: small surface area, high value, and it clarifies notifier boundaries.
3. [ ] Migrate `sensors` second: it owns the central event source and most hardware adapter contracts.
4. [ ] Migrate `telegram` third: it depends on the new `SensorQueryPort`, `NotifierPort`, and user/role ports.
5. [ ] Migrate `camera`, `network`, and `config` as their stubs become real features.
6. [ ] Split Drizzle schema ownership per context after repository ports exist. Do not move tables first.
7. [ ] Move bootstrap reliability concerns last unless PID-lock behavior changes earlier.

## Cross-Cutting Checklist

- [ ] Create fixed layer folders for each touched context: `domain/`, `domain/ports/`, `domain/errors/`, `application/`, `infrastructure/`, and `interfaces/` when there is a bot or HTTP entrypoint.
- [ ] Introduce Symbol tokens beside port interfaces. Token names are `UPPER_SNAKE_CASE`; interfaces have no `I` prefix.
- [ ] Replace direct Drizzle imports outside `infrastructure/` with repository or query ports.
- [ ] Replace direct grammY imports outside `telegram/interfaces/` and `telegram/infrastructure/` with bot handler or gateway abstractions.
- [ ] Keep Nest modules as composition roots: provider wiring only, no business logic.
- [ ] Add mappers at adapter boundaries instead of letting DB rows become domain objects.
- [ ] Add typed domain errors before mapping failures to bot replies.
- [ ] Introduce `ClockPort` for application/domain code when touching code that uses `new Date()` or `Date.now()`.
- [ ] Keep [src/locales/en.ts](../src/locales/en.ts) as the only source of user-facing bot copy.
- [ ] Preserve current behavior while moving files; prefer one context per PR.

## App and Bootstrap

Current files:

- [src/main.ts](../src/main.ts)
- [src/app.module.ts](../src/app.module.ts)

Target shape:

```text
src/
  app.module.ts
  main.ts
  reliability/
    domain/
    application/
    infrastructure/pid-lock.adapter.ts
    reliability.module.ts
```

Checklist:

- [ ] Keep [src/app.module.ts](../src/app.module.ts) as the root import graph only.
- [ ] Move PID-lock filesystem behavior from [src/main.ts](../src/main.ts) into a reliability infrastructure adapter if lock behavior changes.
- [ ] Add a small application service for worker lifecycle only if lifecycle behavior grows beyond lock acquire/release.
- [ ] Keep `NestFactory.create(...)`, shutdown hook registration, and process exit handling in [src/main.ts](../src/main.ts).
- [ ] Test PID-lock behavior as an infrastructure test using a temp directory if the lock code is moved.

## Database

Current files:

- [src/database/database.module.ts](../src/database/database.module.ts)
- [src/database/schema.ts](../src/database/schema.ts)
- [src/database/backup.service.ts](../src/database/backup.service.ts)

Target shape:

```text
src/database/
  database.module.ts          # SQLite + Drizzle singleton only
  schema.ts                   # temporary aggregator during migration
  infrastructure/backup.adapter.ts
src/<context>/infrastructure/db/<context>.schema.ts
src/<context>/infrastructure/drizzle-*.repository.ts
```

Checklist:

- [ ] Keep `DB` and `SQLITE` provider tokens in [src/database/database.module.ts](../src/database/database.module.ts) for now.
- [ ] Do not inject `DB` directly into application or interface classes after a context has repository ports.
- [ ] Split tables from [src/database/schema.ts](../src/database/schema.ts) only after each owning context has a repository adapter.
- [ ] Move `sensors`, `sensorsArchive`, and `sensorLogs` ownership to the sensors infrastructure schema.
- [ ] Move `events` ownership to the events infrastructure schema.
- [ ] Move `users`, `userSensorMutes`, and `inviteCodes` ownership to the telegram or users context once that boundary is decided.
- [ ] Move `cameras` and `motionEvents` ownership to the camera infrastructure schema.
- [ ] Move `features` and `systemMeta` behind dedicated config/feature/system ports before splitting.
- [ ] Turn [src/database/backup.service.ts](../src/database/backup.service.ts) into an infrastructure adapter if backup orchestration becomes a use case.
- [ ] Keep migration generation unchanged until schema aggregation is proven by tests.

## Config

Current file:

- [src/config/config.loader.ts](../src/config/config.loader.ts)

Target shape:

```text
src/config/
  domain/ports/config.port.ts
  infrastructure/yaml-config.loader.ts
  config.module.ts
```

Checklist:

- [ ] Define `ConfigPort` for typed config reads needed by application services.
- [ ] Convert `loadDefaults(...)` into `YamlConfigLoader` implementing `ConfigPort`.
- [ ] Keep YAML parsing and filesystem access in `infrastructure/`.
- [ ] Replace scattered `process.env` reads with injected config where behavior depends on them.
- [ ] Keep one-time config caching inside the adapter, not as module-level mutable state.
- [ ] Add tests for missing file, malformed YAML, and default values.

## Sensors

Current files:

- [src/sensors/sensor.module.ts](../src/sensors/sensor.module.ts)
- [src/sensors/domain/sensor.ts](../src/sensors/domain/sensor.ts)
- [src/sensors/domain/sensor-event.ts](../src/sensors/domain/sensor-event.ts)
- [src/sensors/domain/sensor-reading.ts](../src/sensors/domain/sensor-reading.ts)
- [src/sensors/domain/gpio-pin.value-object.ts](../src/sensors/domain/gpio-pin.value-object.ts)
- [src/sensors/domain/co2.ts](../src/sensors/domain/co2.ts)
- [src/sensors/domain/errors/](../src/sensors/domain/errors)
- [src/sensors/domain/ports/sensor-driver.port.ts](../src/sensors/domain/ports/sensor-driver.port.ts)
- [src/sensors/domain/ports/sensor-repository.port.ts](../src/sensors/domain/ports/sensor-repository.port.ts)
- [src/sensors/domain/ports/sensor-log-repository.port.ts](../src/sensors/domain/ports/sensor-log-repository.port.ts)
- [src/sensors/application/sensor-registry.service.ts](../src/sensors/application/sensor-registry.service.ts)
- [src/sensors/application/reload-sensors.use-case.ts](../src/sensors/application/reload-sensors.use-case.ts)
- [src/sensors/infrastructure/digital-gpio.adapter.ts](../src/sensors/infrastructure/digital-gpio.adapter.ts)
- [src/sensors/infrastructure/mock-gpio.adapter.ts](../src/sensors/infrastructure/mock-gpio.adapter.ts)
- [src/sensors/infrastructure/base-uart-co2.adapter.ts](../src/sensors/infrastructure/base-uart-co2.adapter.ts)
- [src/sensors/infrastructure/uart-co2.adapter.ts](../src/sensors/infrastructure/uart-co2.adapter.ts)
- [src/sensors/infrastructure/mock-uart-co2.adapter.ts](../src/sensors/infrastructure/mock-uart-co2.adapter.ts)
- [src/sensors/infrastructure/mqtt-sensor.adapter.ts](../src/sensors/infrastructure/mqtt-sensor.adapter.ts)
- [src/sensors/infrastructure/camera-sensor.adapter.ts](../src/sensors/infrastructure/camera-sensor.adapter.ts)
- [src/sensors/infrastructure/pigpio.gateway.ts](../src/sensors/infrastructure/pigpio.gateway.ts)
- [src/sensors/infrastructure/drizzle-sensor.repository.ts](../src/sensors/infrastructure/drizzle-sensor.repository.ts)
- [src/sensors/infrastructure/in-memory-sensor.repository.ts](../src/sensors/infrastructure/in-memory-sensor.repository.ts)
- [src/sensors/infrastructure/drizzle-sensor-log.repository.ts](../src/sensors/infrastructure/drizzle-sensor-log.repository.ts)
- [src/sensors/infrastructure/in-memory-sensor-log.repository.ts](../src/sensors/infrastructure/in-memory-sensor-log.repository.ts)
- [src/sensors/infrastructure/sensor-driver.factory.ts](../src/sensors/infrastructure/sensor-driver.factory.ts)

Target shape:

```text
src/sensors/
  domain/
    sensor.entity.ts
    sensor-event.ts
    sensor-reading.ts
    gpio-pin.value-object.ts
    errors/
    ports/sensor-driver.port.ts
    ports/sensor-repository.port.ts
    ports/sensor-query.port.ts
  application/
    sensor-registry.service.ts
    reload-sensors.use-case.ts
  infrastructure/
    digital-gpio.adapter.ts
    mock-gpio.adapter.ts
    uart-co2.adapter.ts
    mqtt-sensor.adapter.ts
    camera-sensor.adapter.ts
    pigpio.gateway.ts
    drizzle-sensor.repository.ts
    drizzle-sensor.query.ts
  sensors.module.ts
```

Checklist:

- [x] Move `SensorType`, `SensorSeverity`, `SensorConfig`, `SensorReading`, and `SensorEvent` from [src/sensors/sensor.interface.ts](../src/sensors/sensor.interface.ts) into domain files.
- [x] Rename `ISensorDriver` to `SensorDriverPort` and place it in `domain/ports/sensor-driver.port.ts`.
- [x] Add `SENSOR_DRIVER_FACTORY`, `SENSOR_REPOSITORY`, and `SENSOR_QUERY` tokens. (`SENSOR_QUERY` deferred — `SensorRepositoryPort` + `SENSOR_LOG_REPOSITORY` cover current use cases; introduce when telegram migrates.)
- [x] Extract `SensorRepositoryPort` for enabled sensor loading and state persistence currently done in [src/sensors/sensor.registry.ts](../src/sensors/sensor.registry.ts).
- [ ] Extract `SensorQueryPort` for read-only status data consumed by telegram.
- [x] Move [src/sensors/sensor.registry.ts](../src/sensors/sensor.registry.ts) to `application/sensor-registry.service.ts` and remove direct Drizzle imports.
- [x] Move driver construction out of the registry constructor into a driver factory bound by [src/sensors/sensor.module.ts](../src/sensors/sensor.module.ts).
- [x] Rename [src/sensors/drivers/digital.driver.ts](../src/sensors/drivers/digital.driver.ts) to `digital-gpio.adapter.ts`.
- [x] Rename [src/sensors/drivers/mock.driver.ts](../src/sensors/drivers/mock.driver.ts) to `mock-gpio.adapter.ts`.
- [x] Rename [src/sensors/drivers/uart.driver.ts](../src/sensors/drivers/uart.driver.ts) to `uart-co2.adapter.ts` when serialport implementation begins.
- [x] Rename [src/sensors/drivers/mqtt.driver.ts](../src/sensors/drivers/mqtt.driver.ts) to `mqtt-sensor.adapter.ts` when MQTT implementation begins.
- [x] Rename [src/sensors/drivers/camera.driver.ts](../src/sensors/drivers/camera.driver.ts) to `camera-sensor.adapter.ts` if camera remains a sensor source.
- [x] Keep [src/sensors/drivers/pigpio.gateway.ts](../src/sensors/drivers/pigpio.gateway.ts) as an infrastructure gateway, not a domain port.
- [x] Move GPIO pin range validation into a `GpioPin` value object or typed domain error.
- [x] Decide whether JS-level debounce belongs in `SensorRegistry`/application or remains adapter-local; keep hardware glitch filtering in the pigpio adapter. (Both remain adapter-local in `DigitalGpioAdapter`.)
- [x] Replace raw `Error` throws in digital config parsing with typed domain errors.
- [x] Add domain tests for `GpioPin`, severity parsing, and digital config validation. (Severity is a plain union; covered indirectly via repository mapping tests.)
- [x] Add application tests for reload behavior with an in-memory sensor repository and mock driver factory.
- [x] Keep the existing GPIO-driver integration test pattern from [test/sensors/digital.driver.test.ts](../test/sensors/digital.driver.test.ts), then rename it with the adapter.

## Events

Current files:

- [src/events/event.module.ts](../src/events/event.module.ts)
- [src/events/domain/queued-event.entity.ts](../src/events/domain/queued-event.entity.ts)
- [src/events/domain/event-summary.ts](../src/events/domain/event-summary.ts)
- [src/events/domain/sensor-event.ts](../src/events/domain/sensor-event.ts)
- [src/events/domain/ports/clock.port.ts](../src/events/domain/ports/clock.port.ts)
- [src/events/domain/ports/event-repository.port.ts](../src/events/domain/ports/event-repository.port.ts)
- [src/events/domain/ports/notifier.port.ts](../src/events/domain/ports/notifier.port.ts)
- [src/events/domain/ports/sensor-event-source.port.ts](../src/events/domain/ports/sensor-event-source.port.ts)
- [src/events/application/event-notifier.service.ts](../src/events/application/event-notifier.service.ts)
- [src/events/application/event-processor.service.ts](../src/events/application/event-processor.service.ts)
- [src/events/application/event-queue.service.ts](../src/events/application/event-queue.service.ts)
- [src/events/application/drain-event-queue.use-case.ts](../src/events/application/drain-event-queue.use-case.ts)
- [src/events/application/ports/event-queue-options.port.ts](../src/events/application/ports/event-queue-options.port.ts)
- [src/events/infrastructure/drizzle-event.repository.ts](../src/events/infrastructure/drizzle-event.repository.ts)
- [src/events/infrastructure/in-memory-event.repository.ts](../src/events/infrastructure/in-memory-event.repository.ts)
- [src/events/infrastructure/system-clock.adapter.ts](../src/events/infrastructure/system-clock.adapter.ts)

Target shape:

```text
src/events/
  domain/
    queued-event.entity.ts
    event-summary.ts
    sensor-event.ts
    errors/
    ports/clock.port.ts
    ports/event-repository.port.ts
    ports/notifier.port.ts
    ports/sensor-event-source.port.ts
  application/
    event-notifier.service.ts
    event-queue.service.ts
    drain-event-queue.use-case.ts
    event-processor.service.ts
    ports/event-queue-options.port.ts
  infrastructure/
    drizzle-event.repository.ts
    in-memory-event.repository.ts
    system-clock.adapter.ts
  event.module.ts
```

Checklist:

- [x] Move `QueuedEvent` from the legacy queue file into domain.
- [x] Add `EventRepositoryPort` for `enqueue`, `pending`, and `markSent`.
- [x] Move Drizzle persistence from the legacy queue file to `DrizzleEventRepository`.
- [x] Keep queue orchestration in an application service that depends on `EventRepositoryPort`.
- [x] Add `NotifierPort` for outbound messages instead of the legacy processor using `setSender(...)`.
- [x] Add `SensorEventSourcePort` or export an event subscription port from sensors instead of depending on `SensorRegistry` directly.
- [x] Move aggregation formatting into an application/domain function that can be unit tested without Nest.
- [ ] Replace `sleep(...)` and fixed retry delays with an injectable timer/backoff strategy if drain behavior changes.
- [x] Replace direct `process.env.MAX_QUEUE_BEFORE_FORCE_AGGREGATE` reads with module-level queue options.
- [x] Add `InMemoryEventRepository` for use-case tests.
- [x] Add tests for single event summary, multi-event summary, force-file threshold, send failure retry, and `markSent` timestamp behavior.

## Telegram

Current files:

- [src/telegram/bot.module.ts](../src/telegram/bot.module.ts)
- [src/telegram/bot.service.ts](../src/telegram/bot.service.ts)
- [src/telegram/guards/role.guard.ts](../src/telegram/guards/role.guard.ts)
- [src/telegram/commands/claim-admin.command.ts](../src/telegram/commands/claim-admin.command.ts)
- [src/telegram/commands/status.command.ts](../src/telegram/commands/status.command.ts)
- [src/telegram/commands/ping.command.ts](../src/telegram/commands/ping.command.ts)
- [src/telegram/commands/help.command.ts](../src/telegram/commands/help.command.ts)
- [src/telegram/flows/flow.engine.ts](../src/telegram/flows/flow.engine.ts)

Target shape:

```text
src/telegram/
  domain/
    telegram-user.entity.ts
    role.ts
    errors/
    ports/user-repository.port.ts
    ports/recipient-query.port.ts
  application/
    claim-admin.use-case.ts
    list-recipients.use-case.ts
  infrastructure/
    grammy-bot.gateway.ts
    telegram-notifier.adapter.ts
    drizzle-user.repository.ts
  interfaces/
    claim-admin.handler.ts
    status.handler.ts
    ping.handler.ts
    help.handler.ts
    role.middleware.ts
  telegram.module.ts
```

Checklist:

- [ ] Move command classes from `commands/` to `interfaces/` as handlers when touched.
- [ ] Keep grammY `Bot` and `Context` imports inside `interfaces/` or `infrastructure/` only.
- [ ] Split [src/telegram/bot.service.ts](../src/telegram/bot.service.ts) into a `GrammyBotGateway` plus application-independent registration of handlers.
- [ ] Move recipient lookup in [src/telegram/bot.service.ts](../src/telegram/bot.service.ts) behind `RecipientQueryPort`.
- [x] Implement `NotifierPort` from events as `TelegramNotifier` in telegram infrastructure.
- [ ] Extract `UserRepositoryPort` for users, roles, invite codes, mute state, and recipient listing.
- [ ] Move direct Drizzle access out of [src/telegram/guards/role.guard.ts](../src/telegram/guards/role.guard.ts) into a role/query port.
- [ ] Extract `ClaimAdminUseCase` from [src/telegram/commands/claim-admin.command.ts](../src/telegram/commands/claim-admin.command.ts).
- [ ] Replace `hasAdmin()` and `getAdmins()` helper queries with use cases or repository methods.
- [ ] Change [src/telegram/commands/status.command.ts](../src/telegram/commands/status.command.ts) to consume `SensorQueryPort`, not the `sensors` Drizzle table.
- [ ] Keep [src/telegram/commands/ping.command.ts](../src/telegram/commands/ping.command.ts) and [src/telegram/commands/help.command.ts](../src/telegram/commands/help.command.ts) as thin handlers; they need no use case unless behavior grows.
- [ ] Decide whether user/role ownership stays under telegram or becomes a separate `users` context before implementing `/invite`, `/promote`, `/mute`, and quiet hours.
- [ ] Move [src/telegram/flows/flow.engine.ts](../src/telegram/flows/flow.engine.ts) out of telegram into a future `flows` or `automation` context before Phase 2 work begins.
- [ ] Add handler tests for domain-error to reply mapping using [src/locales/en.ts](../src/locales/en.ts).

## Camera

Current files:

- [src/camera/camera.module.ts](../src/camera/camera.module.ts)
- [src/camera/motion.service.ts](../src/camera/motion.service.ts)
- Drive sync (spec 21) is implemented under `application/` (`upload-motion`, `cleanup-local-storage`, `cleanup-drive`, `backup-upload`, `drive-sync.scheduler`) and `infrastructure/` (rclone/fs/drizzle/sqlite adapters + stubs); the old root `upload.service.ts` / `cleanup.service.ts` stubs were removed.

Target shape:

```text
src/camera/
  domain/
    camera.entity.ts
    motion-event.entity.ts
    media-file.value-object.ts
    retention-policy.value-object.ts
    ports/motion-control.port.ts
    ports/cloud-upload.port.ts
    ports/media-repository.port.ts
    ports/media-store.port.ts
  application/
    start-motion.use-case.ts
    stop-motion.use-case.ts
    upload-pending-media.use-case.ts
    cleanup-media.use-case.ts
  infrastructure/
    motion-daemon.adapter.ts
    rclone-gdrive-uploader.adapter.ts
    local-media-store.adapter.ts
    drizzle-motion-event.repository.ts
  camera.module.ts
```

Checklist:

- [ ] Do the folder split before replacing the current stubs with real `systemctl`, Motion, rclone, or filesystem calls.
- [ ] Define `MotionControlPort` before implementing [src/camera/motion.service.ts](../src/camera/motion.service.ts).
- [x] Drive sync ports defined and implemented (spec 21): `DriveSyncPort`, `LocalStoragePort`, `RetentionPrunePort`, `DbBackupPort` (in addition to the existing `DriveStatusPort`).
- [ ] Define `MediaRepositoryPort` for `motionEvents` rows before writing cleanup or upload state changes.
- [ ] Define `MediaStorePort` for local file deletion and size calculations.
- [ ] Keep process execution, filesystem paths, and rclone command details in infrastructure adapters.
- [ ] Add domain tests for retention policy and media file state transitions.
- [ ] Add application tests for upload retry behavior and cleanup thresholds using in-memory adapters.
- [ ] Adapter-test `systemctl` and rclone wrappers by mocking the child-process boundary; do not run real daemon commands in CI.

## Network

Current files:

- [src/network/network.module.ts](../src/network/network.module.ts)
- [src/network/network.service.ts](../src/network/network.service.ts)

Target shape:

```text
src/network/
  domain/
    network-status.ts
    heartbeat-target.value-object.ts
    ports/heartbeat-client.port.ts
    ports/network-probe.port.ts
  application/
    heartbeat-scheduler.service.ts
    check-network-health.use-case.ts
  infrastructure/
    fetch-heartbeat-client.adapter.ts
    os-network-probe.adapter.ts
  network.module.ts
```

Checklist:

- [ ] Split scheduling from network I/O in [src/network/network.service.ts](../src/network/network.service.ts).
- [ ] Put `fetch(...)` behind `HeartbeatClientPort`.
- [ ] Put Wi-Fi or OS-level checks behind `NetworkProbePort` when specs 22/23 are implemented.
- [ ] Replace direct `process.env.HEARTBEAT_*` reads with `ConfigPort` when heartbeat behavior changes.
- [ ] Add timer cleanup tests for the scheduler.
- [ ] Add adapter tests for failed heartbeat responses and network exceptions.

## Locales

Current file:

- [src/locales/en.ts](../src/locales/en.ts)

Checklist:

- [ ] Keep this as interface-layer copy, not domain language.
- [ ] Expand namespaces as handlers are migrated.
- [ ] Do not import [src/locales/en.ts](../src/locales/en.ts) from domain or application code.
- [ ] Map domain errors to locale keys in telegram handlers only.

## Flows / Automation

Current file:

- [src/telegram/flows/flow.engine.ts](../src/telegram/flows/flow.engine.ts)

Target shape:

```text
src/flows/
  domain/
    flow-rule.entity.ts
    condition.value-object.ts
    action.value-object.ts
    ports/flow-repository.port.ts
    ports/action-dispatcher.port.ts
  application/
    evaluate-flow.use-case.ts
    flow-engine.service.ts
  infrastructure/
    drizzle-flow.repository.ts
  flows.module.ts
```

Checklist:

- [ ] Move flow/automation work out of telegram before Phase 2 implementation begins.
- [ ] Treat telegram commands as one interface that can configure flows, not as the owner of flow logic.
- [ ] Add `SensorQueryPort` dependency for condition evaluation instead of importing sensor infrastructure.
- [ ] Add `ActionDispatcherPort` so future actions can target telegram, camera, or system update adapters.
- [ ] Add use-case tests for rule matching, disabled rules, and failed action dispatch.

## Definition of Done for a Migrated Context

A context counts as migrated when all of these are true:

- [ ] It has `domain/`, `application/`, `infrastructure/`, and optional `interfaces/` folders.
- [ ] No file in `domain/` imports Nest except optional `Injectable`.
- [ ] No file in `domain/` imports Drizzle, grammY, pigpio, serialport, filesystem APIs, process APIs, or child-process APIs.
- [ ] No file in `application/` imports concrete adapters or Drizzle schema files.
- [ ] Interface handlers call use cases or application services; they do not query DB tables.
- [ ] All cross-context dependencies are port tokens or exported application services, never another context's infrastructure class.
- [ ] The context module binds ports to adapters and exports only tokens or application services needed by other contexts.
- [ ] Domain tests cover value objects and invariants.
- [ ] Application tests cover use cases with in-memory adapters.
- [ ] Infrastructure tests cover real adapter mappings and translated errors.
- [ ] [docs/ports-and-adapters.md](ports-and-adapters.md) is updated for every new or renamed port.
