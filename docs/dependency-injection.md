# Dependency Injection — Nest as the Composition Root

> **Dependencies:** [architecture.md](architecture.md), [ports-and-adapters.md](ports-and-adapters.md).

Nest's `@Module` is the **only** place ports are bound to adapters. Use cases never `new` an adapter; they receive it through DI.

## Tokens, not classes, for ports

Concrete-class injection is fine when there is exactly one implementation forever (gateways, application services). For anything that might be mocked or swapped — **inject by Symbol token**.

```ts
// src/events/domain/ports/event-repository.port.ts
export const EVENT_REPOSITORY = Symbol('EVENT_REPOSITORY');

export interface EventRepositoryPort {
  insert(event: SensorEvent): Promise<QueuedEvent>;
  pending(limit?: number): Promise<QueuedEvent[]>;
  markSent(ids: number[], at: Date): Promise<void>;
}
```

```ts
// src/events/application/drain-event-queue.use-case.ts
@Injectable()
export class DrainEventQueueUseCase {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly repo: EventRepositoryPort,
    @Inject(NOTIFIER) private readonly notifier: NotifierPort,
  ) {}

  async execute(): Promise<void> { /* … */ }
}
```

```ts
// src/events/event.module.ts (composition root for the context)
@Module({
  providers: [
    DrainEventQueueUseCase,
    { provide: EVENT_REPOSITORY, useClass: DrizzleEventRepository },
    { provide: NOTIFIER, useExisting: TelegramNotifier },  // bound across contexts via re-export
  ],
  exports: [EVENT_REPOSITORY],
})
export class EventModule {}
```

### Token rules

- Symbol, not string. `Symbol('EVENT_REPOSITORY')`. Strings collide silently across rebuilds.
- Token name is `UPPER_SNAKE_CASE` and matches the port concept, not the interface name. `EVENT_REPOSITORY`, not `IEVENT_REPOSITORY_PORT`.
- The token and the interface live in the **same file**. Consumers import both; one of them rarely without the other.
- Token files live under `domain/ports/` or `application/ports/` — never under `infrastructure/`.

## Environment-driven adapter selection

When the choice between adapters depends on environment (dev mock vs production real), bind via `useFactory`:

```ts
{
  provide: SENSOR_DRIVER_FACTORY,
  useFactory: (pigpio: PigpioGateway): SensorDriverFactory =>
    process.env.NODE_ENV === 'development'
      ? () => new MockGpioAdapter()
      : () => new DigitalGpioAdapter(pigpio),
  inject: [PigpioGateway],
}
```

If the choice gets more complex (per-sensor type, per-feature flag), encapsulate it in a single `*.factory.ts` file in `infrastructure/` that the module imports. Do not scatter `if (env)` across multiple providers.

## Cross-context wiring

A port owned by context A but implemented by context B is bound in **A's** module, with `useExisting` pointing at B's exported provider:

```ts
// src/telegram/telegram.module.ts
@Module({
  imports: [EventModule, SensorModule],  // brings in their exports
  providers: [
    { provide: NOTIFIER, useExisting: TelegramNotifier },
  ],
})
```

The implementing module exports its concrete class; the consuming module rebinds it to the port token. This keeps `events/` from importing anything from `telegram/`.

## What stays a plain class

- **Application services** (`SensorRegistry`, `EventProcessor`) — Nest injects them by class; no token needed.
- **Domain entities & value objects** — never DI'd. Constructed by use cases / mapped from rows.
- **Single-implementation gateways** (`PigpioGateway`) — injected by class. Promote to a port only when a second adapter actually exists.

## DI anti-patterns

- `useClass` for a port that has a mock — that's a string-typed coupling; use the env/factory pattern above.
- `forwardRef()` between modules — it almost always means context boundaries are wrong. Extract a port into the consumed context.
- A module that exports a concrete repository class — export the token only.
- Manual `new` of an adapter inside a use case. Always `@Inject`.
- Putting Nest DI metadata on a domain entity. Entities are not providers.

## Global modules

[`DatabaseModule`](../src/database/database.module.ts) is `@Global()` because the SQLite handle and Drizzle wrapper are a process-wide singleton. This is the **only** legitimate use of `@Global()` in the repo. New shared providers should be imported explicitly through `imports: [...]`, not made global.

## Lifecycle hooks

Hex-friendly placement of Nest lifecycle hooks:

| Hook | Lives in |
|---|---|
| `OnModuleInit` / `OnModuleDestroy` | `application/` services (e.g. `SensorRegistry`) when the work is orchestration; `infrastructure/` when it's resource setup (sockets, file handles, daemons). |
| `OnApplicationBootstrap` / `OnApplicationShutdown` | Use sparingly; only for cross-context coordination (e.g. starting the bot poller after sensors are ready). |

Domain code never has lifecycle hooks.
