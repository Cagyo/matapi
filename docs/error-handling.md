# Error Handling

> **Dependencies:** [architecture.md](architecture.md).

Three categories. Each has one canonical handling pattern. Mixing them is the bug.

```
Domain failures      → typed domain error classes; thrown or returned per layer rule
Expected I/O errors  → caught at the adapter boundary, mapped to a domain error
Unexpected errors    → let them throw; Nest logs + PM2 restarts; never swallow
```

## Domain errors — typed classes in `domain/errors/`

```ts
// src/sensors/domain/errors/pin-already-in-use.error.ts
export class PinAlreadyInUseError extends Error {
  readonly code = 'PIN_ALREADY_IN_USE' as const;
  constructor(readonly pin: number, readonly owner: string) {
    super(`GPIO pin ${pin} is already used by sensor '${owner}'`);
    this.name = 'PinAlreadyInUseError';
  }
}
```

- One file per error class. PascalCase + `Error` suffix.
- A `readonly code` discriminator (`UPPER_SNAKE`) — for switch/match at the boundary.
- Constructor captures the data needed to render the message **and** the data needed to render a user reply later — do not lose the pin number.
- No `cause`-chaining of infrastructure errors into domain errors; map and discard the underlying stack at the adapter (log it there).

## Where to throw vs return

| Layer | Failure form |
|---|---|
| `domain` (value-object constructors, invariants) | **Throw** the domain error. Construction of an invalid value object is a bug to surface. |
| `application/` use cases — single result | **Throw** the domain error. The interface layer catches and maps. |
| `application/` use cases — multi-item batch where partial success matters (e.g. drain event queue, reload sensors) | **Return** `{ ok, failed }` with each failure carrying the domain error. Never throw mid-batch. See `SensorRegistry.reload()` for the live example: it logs and skips per row. |
| `infrastructure/` adapters | Translate underlying exception to a domain error, then **throw**. Never leak Drizzle / grammY / pigpio error types upward. |
| `interfaces/` (bot handlers) | **Catch** all errors. Switch on `error.code`. Reply via [src/locales/en.ts](../src/locales/en.ts). Re-throw only `unknown` errors after logging. |

The `Result<T, E>` / `Either` pattern is **not used** here. Throwing typed errors keeps Nest's interceptor model intact and matches the rest of the Node ecosystem. The batched-use-case return type is the only structured-result exception.

## Adapter boundary mapping

```ts
// src/sensors/infrastructure/drizzle-sensor.repository.ts
async create(sensor: NewSensor): Promise<Sensor> {
  try {
    return await this.db.insert(sensors).values(toRow(sensor)).returning().get();
  } catch (err) {
    if (isUniqueViolation(err, 'sensors_name_unique')) {
      throw new SensorNameTakenError(sensor.name);
    }
    throw err;  // unknown DB error — let it bubble
  }
}
```

Rules:

1. Catch only what you know how to translate. Unknown errors must propagate.
2. The check for the underlying error type lives **in the adapter** — `isUniqueViolation` is a helper next to the adapter, never in domain.
3. Log the original error at `warn` here; the domain error you re-throw is what reaches the user.

## Interface boundary mapping — bot example

```ts
// src/telegram/interfaces/add-sensor.handler.ts
try {
  await this.addSensor.execute({ name, type, pin });
  await ctx.reply(en.config.added(name));
} catch (err) {
  if (err instanceof PinAlreadyInUseError) {
    await ctx.reply(en.config.pinTaken(err.pin, err.owner));
    return;
  }
  if (err instanceof SensorNameTakenError) {
    await ctx.reply(en.config.nameTaken(err.name));
    return;
  }
  this.logger.error(`/config add failed: ${(err as Error).message}`, (err as Error).stack);
  await ctx.reply(en.common.error('add sensor', 'internal error'));
}
```

- One `if (err instanceof ...)` arm per domain error the use case is allowed to throw.
- The default branch logs the stack and replies with a generic message — never the raw error string (security & UX).
- All user-facing strings come from `en.ts` keys, never from `error.message`.

## Logging

- Use the injected Nest `Logger` (per class). Never `console.log`.
- Log levels: `error` for an unexpected failure, `warn` for a translated/recovered domain failure that the user already saw, `log` for state transitions, `debug` for high-volume detail behind `LOG_LEVEL`.
- **Never** log: `TELEGRAM_BOT_TOKEN`, full chat IDs in `info`/`error`, `.env` values, raw sensor payloads if they could contain secrets, full file paths under `data/`.

## Crash policy

- **Do not** add top-level `try/catch` to suppress crashes "just in case". PM2 restarts on crash; that is the contract.
- **Do** add narrow `try/catch` when a failed iteration must not abort the loop (sensor reload, queue drain, bot handler).
- Unhandled rejections in async code: do nothing special — Node will surface them; PM2 will restart.

## What NOT to do

- Returning `null` to mean "an error happened". `null` means absence; an error class means failure.
- Catching an error to `console.error` and continuing as if nothing happened.
- A single `BusinessError` class with a `type` string field. Use one class per error.
- Throwing strings (`throw 'oops'`) or plain objects.
- Letting a Drizzle `SqliteError` reach a bot handler.
