# Naming & Conventions

> **Dependencies:** [architecture.md](architecture.md).

Names carry the architecture. A grep-able convention is the cheapest enforcement we have until ESLint boundaries land.

## File names — `kebab-case.kind.ts`

```
sensor.entity.ts                 ← domain entity
sensor-event.value-object.ts     ← value object (suffix optional for short names)
sensor-driver.port.ts            ← port (interface + token)
pin-already-in-use.error.ts      ← domain error class
reload-sensors.use-case.ts       ← application use case
sensor-registry.service.ts       ← application service (stateful coordinator)
digital-gpio.adapter.ts          ← infrastructure adapter implementing a port
drizzle-event.repository.ts      ← infrastructure repository (adapter for Repository port)
pigpio.gateway.ts                ← infrastructure single-impl utility
yaml-config.loader.ts            ← infrastructure loader
status.handler.ts                ← interfaces bot/HTTP handler
sensor.module.ts                 ← Nest module (composition root)
```

**Kind suffixes — pick from this list, do not invent:**

| Suffix | Layer | Means |
|---|---|---|
| `.entity` | domain | An aggregate root or domain entity with identity |
| `.value-object` | domain | An immutable value object (suffix optional for unambiguous names) |
| `.port` | domain or application | A port interface (+ its token) |
| `.error` | domain | A typed domain error |
| `.use-case` | application | One business operation, one class, one public `execute` method |
| `.service` | application | Long-lived application service (`SensorRegistry`) |
| `.adapter` | infrastructure | Implementation of a port against external tech |
| `.repository` | infrastructure | Adapter for a Repository-shaped port |
| `.gateway` | infrastructure | Single-impl utility wrapping an external system, no port abstraction |
| `.loader` / `.factory` / `.mapper` | infrastructure | Self-explanatory utility kinds |
| `.handler` | interfaces | Bot/HTTP entry-point class |
| `.module` | (composition) | Nest module |

Do not use generic suffixes (`.manager`, `.helper`, `.util`, `.controller` outside HTTP).

## Class names — PascalCase, suffix matches file

| File | Class |
|---|---|
| `reload-sensors.use-case.ts` | `ReloadSensorsUseCase` |
| `digital-gpio.adapter.ts` | `DigitalGpioAdapter` |
| `sensor-driver.port.ts` | `SensorDriverPort` (interface), `SENSOR_DRIVER_FACTORY` (token) |
| `pin-already-in-use.error.ts` | `PinAlreadyInUseError` |
| `drizzle-event.repository.ts` | `DrizzleEventRepository` |

**No `I` prefix** on interfaces. The legacy `ISensorDriver` will be renamed to `SensorDriverPort` when next touched.

## Interface vs type

- `interface` for ports and any shape another class will implement.
- `type` for unions, discriminated unions, mapped types, tuples.

## Tokens — `UPPER_SNAKE_CASE` Symbols

```ts
export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');
```

Same name as the conceptual port, no `_PORT` / `_TOKEN` suffix. Lives in the same file as the interface.

## Folder names

```
src/
  sensors/                ← bounded context, plural noun
    domain/
      ports/              ← one file per port
      errors/             ← one file per error class
    application/
    infrastructure/
    interfaces/           ← optional
    sensors.module.ts
```

- Context folders are **plural** (`sensors`, `events`, `cameras`).
- Layer folders are **singular** (`domain`, `application`, `infrastructure`, `interfaces`) and fixed — no synonyms (no `app/`, no `usecases/`, no `core/`).
- No `shared/` or `common/` folders inside a context. If two contexts need the same concept, one of them owns it and exports a port.

## Variable & method names

- Methods are verbs: `execute`, `reload`, `drain`, `notify`, `findById`. Avoid `get*` for anything that does I/O — use `load*` or `fetch*` to signal cost.
- Booleans read as predicates: `isEnabled`, `hasPin`, `canMute`. No `flag`, no `status` as a boolean.
- Avoid `data`, `info`, `obj`, `item` as variable names.

## Async signature rules

- Every method that crosses an I/O boundary returns `Promise<T>` — no fire-and-forget except inside infrastructure where the underlying API is callback-based and the wrapper bridges it.
- No `void` returns from use cases that have meaningful output; return the entity or a small result DTO.

## Imports — direction matches the dependency rule

A static check, in your head:

```ts
// Inside src/sensors/application/*
import { Sensor } from '../domain/sensor.entity';                          // ✅
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';     // ✅
import { DigitalGpioAdapter } from '../infrastructure/digital-gpio.adapter'; // ❌ — depend on the port
import { db } from '../../database';                                       // ❌ — go through a port
```

Use relative imports inside a context (`../domain/...`); use absolute-from-`src` imports (`src/events/...`) **only** to cross contexts, and only to import a published port — never an adapter.

## Module exports

A context's `*.module.ts` exports **port tokens** (and application services consumed by other contexts). It does **not** export concrete repositories, adapters, or domain entities. Other contexts that need to construct entities use the published use cases.

## Domain-language rules

- One name per concept across the whole codebase. If domain says `SensorEvent`, infrastructure does not call it `EventRow`. Use a mapper at the boundary instead of a synonym.
- Avoid prefix/suffix noise (`DomainSensor`, `SensorDTO`, `SensorModel`). The path already says what layer it's in.

## When in doubt — grep test

If you can't find every use case in the repo with `grep -r '\.use-case\.ts' src/`, the convention has been violated. Same for `.adapter.ts`, `.port.ts`, `.error.ts`.
