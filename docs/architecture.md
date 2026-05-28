# Architecture — Hexagonal (Ports & Adapters) on NestJS

> **Dependencies:** none. This is the root architecture doc. Read before [ports-and-adapters.md](ports-and-adapters.md), [dependency-injection.md](dependency-injection.md), [testing.md](testing.md).

This repo follows **hexagonal architecture** — also known as ports & adapters. NestJS provides the DI container and lifecycle hooks; it does **not** dictate how layers depend on each other. This doc does.

## The dependency rule

```
interfaces  →  application  →  domain  ←  infrastructure
   (bot,        (use cases,      (entities,     (drizzle, pigpio,
    HTTP)        ports)           value objects,  grammY, motion,
                                  domain errors)   rclone, serialport)
```

Arrows point in the direction a layer may import from. Concretely:

| Layer | May import from | May NOT import |
|---|---|---|
| `domain` | nothing (stdlib only) | Nest, Drizzle, grammY, pigpio, serialport, fs, child_process |
| `application` | `domain` (same context), `domain` of other contexts via published ports | Any infrastructure package, Nest controllers/gateways, `interfaces/` |
| `infrastructure` | `domain` + `application` (to implement ports) | Other contexts' `infrastructure` (talk via the other context's published port) |
| `interfaces` | `application` (to invoke use cases) | `infrastructure` directly (resolve via DI token) |

**Pragmatic relaxation:** `@Injectable()` from `@nestjs/common` is allowed in `domain` and `application` for DI ergonomics. **No other Nest import** (no `@Inject`, `Logger`, lifecycle hooks, decorators) and **no third-party runtime dependency** may appear in `domain`. `Logger` and `@Inject` are allowed in `application`.

## Folder layout — feature-sliced

Each bounded context (≈ today's Nest module) owns a folder under `src/`. Inside, the hex slices are subfolders:

```
src/
  <context>/
    domain/              ← entities, value objects, domain errors, port interfaces
    application/         ← use cases (one class per use case), orchestrators
    infrastructure/      ← adapters: implementations of ports against real tech
    interfaces/          ← optional — local entrypoints (e.g. bot command handlers)
    <context>.module.ts  ← composition root for the context (DI wiring only)
```

A **port** lives in `domain/ports/` (or `application/ports/` if it only exists to serve a use case). An **adapter** lives in `infrastructure/` and implements one port.

### Target layout, mapped to current code

| Today | Target |
|---|---|
| [src/sensors/sensor.interface.ts](../src/sensors/sensor.interface.ts) | `src/sensors/domain/{sensor.ts, sensor-event.ts, ports/sensor-driver.port.ts}` |
| [src/sensors/sensor.registry.ts](../src/sensors/sensor.registry.ts) | `src/sensors/application/sensor-registry.service.ts` |
| [src/sensors/drivers/digital.driver.ts](../src/sensors/drivers/digital.driver.ts) | `src/sensors/infrastructure/digital-gpio.adapter.ts` |
| [src/sensors/drivers/pigpio.gateway.ts](../src/sensors/drivers/pigpio.gateway.ts) | `src/sensors/infrastructure/pigpio.gateway.ts` (low-level, internal) |
| legacy `src/events/event.queue.ts` | [src/events/application/event-queue.service.ts](../src/events/application/event-queue.service.ts) + [src/events/infrastructure/drizzle-event.repository.ts](../src/events/infrastructure/drizzle-event.repository.ts) (implements `EventRepositoryPort`) |
| [src/telegram/commands/status.command.ts](../src/telegram/commands/status.command.ts) | `src/telegram/interfaces/status.handler.ts` (talks to `SensorQueryPort` from `sensors/application`, not Drizzle) |
| [src/database/schema.ts](../src/database/schema.ts) | `src/<context>/infrastructure/db/schema.ts` — schema lives with the adapter that owns the table; aggregated by [src/database/database.module.ts](../src/database/database.module.ts) |

### Bounded contexts in this repo

`sensors`, `events`, `telegram`, `camera`, `network`, `database` (cross-cutting infrastructure), `config` (cross-cutting infrastructure).

**Cross-context calls go through ports.** Telegram's `/status` command must not query the `sensors` Drizzle table directly — it depends on a `SensorQueryPort` exposed by `sensors/application/`. This is the rule that lets us swap Drizzle for anything else without touching `telegram/`.

## What goes in each layer

### domain/

- Pure types and entities (`Sensor`, `SensorEvent`, `MotionEvent`, `User`).
- Value objects (`GpioPin`, `Severity`, `QuietHours`).
- Domain errors as typed classes (`PinAlreadyInUse`, `SensorOffline`) — see [error-handling.md](error-handling.md).
- **Port interfaces** — what the application asks the outside world to do (`SensorDriverPort`, `NotifierPort`, `EventRepositoryPort`, `ClockPort`).

No I/O. No async unless the port itself is async. No Date.now() — inject a `ClockPort`.

### application/

- **Use cases**: one class per business operation (`ReloadSensorsUseCase`, `DrainEventQueueUseCase`, `MuteUserUseCase`). Public method is named after the operation (`execute`, `run`, or a verb).
- **Application services**: long-lived stateful coordinators when a use case can't model it (`SensorRegistry`, `EventProcessor`).
- Depends on domain ports, not adapters.

### infrastructure/

- One adapter per port per tech (`DigitalGpioAdapter` implements `SensorDriverPort` against pigpio; `MockGpioAdapter` implements it for dev).
- Drizzle schemas, repositories, query builders.
- grammY bot setup, rclone process management, Motion daemon control, serialport wrappers.
- Maps DB rows / wire formats to domain types **at the boundary**.

### interfaces/

- Bot command handlers (grammY callbacks).
- HTTP controllers (none today; reserved).
- Wire input → use-case parameters; map use-case output / errors → user-facing replies (via [src/locales/en.ts](../src/locales/en.ts)).

## Composition root

The Nest `*.module.ts` is the **only** place where a port is bound to a concrete adapter. Use injection tokens (Symbols) for ports — never bind to a concrete class. See [dependency-injection.md](dependency-injection.md).

```ts
// src/sensors/sensor.module.ts (target)
@Module({
  providers: [
    SensorRegistry,                                    // application
    { provide: SENSOR_DRIVER_FACTORY,                  // port → adapter switch
      useFactory: (pigpio) =>
        process.env.NODE_ENV === 'development'
          ? () => new MockGpioAdapter()
          : () => new DigitalGpioAdapter(pigpio),
      inject: [PigpioGateway] },
    PigpioGateway,
  ],
  exports: [SensorRegistry, SENSOR_QUERY_PORT],
})
export class SensorModule {}
```

## Migration policy

**Enforce going forward.** No big-bang rewrite.

- **New contexts** must be hex from day one.
- **New use cases inside existing contexts** must live in `application/` and depend on ports.
- **Meaningful changes** (≥ ~50 LOC or any behavior change) to an existing file must move it to the right layer in the same PR.
- **Cross-context coupling**: the moment a feature would require importing another context's Drizzle table directly, introduce the port first.

Existing code that violates the rule above remains as-is until touched. Do not file refactor-only PRs to reshuffle folders.

## Anti-patterns

- Importing `drizzle-orm` or `db/schema` from `application/` or `domain/`.
- A use case that depends on a concrete adapter class instead of a port.
- A bot command that runs a SQL query.
- A driver/adapter that owns business rules (e.g. debounce policy belongs in `application/`, not the GPIO adapter; the hardware glitch filter is fine because it's a tech concern).
- A "shared" or "common" folder of cross-context types — promote to a published port instead.
- Reusing a port name across contexts (`Repository`, `Service`) without the context prefix.

## When in doubt

Ask: *"If I swap Drizzle for Postgres / replace grammY with Slack / replace pigpio with a TCP-based GPIO server, how many files change?"* The answer should be: only files in the relevant `infrastructure/` folder, plus one line in the `*.module.ts` composition root.
