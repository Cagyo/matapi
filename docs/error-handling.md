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

## Contextual workflow navigation

Workflow-return CAS outcomes are expected control flow, not exceptions.
`expired`, `superseded`, and `terminal` callbacks are acknowledged and then make
no mutation; `resumable` leaves the exact receipt available for its retry
control. A restore delivery failure is compensated with receipt-bound retry
markup and a localized unavailable reply. The receipt is completed only after
the required terminal delivery/restore stage succeeds.

An in-memory draft can be missing after a process restart. Returning its exact
cancellable receipt still re-authorizes and restores the origin, with the
localized interrupted/expired-setup notice; it must not recreate or mutate a
newer draft. Running work continues through restart recovery: terminal output
is delivered first, then a fresh authorized Home is restored only if the user
has not already returned.

## Feature install failures across the privilege boundary

The root routine cannot hand the worker a message, only an exit status, so every
install cause is a reserved status translated once — in
[feature-installer.py](../scripts/feature-installer.py) — and never re-derived
downstream.

| Routine exit | `FeatureInstallFailureCode` |
|---|---|
| 20 | `local-network-unavailable` |
| 21 | `network-policy-generation-failed` |
| 22 | `dependency-install-failed` |
| 23 | `privileged-verification-failed` |
| any other non-zero | `dependency-install-failed` |

The RTSP routine reports `23` for root verification **and** for every failure
after its first durable rename, which is why that code can never prove the
previously installed policy survived. Raw route output, package errors, and
helper diagnostics stay in the root journal; the code is the entire payload that
crosses.

The application side has its own closed vocabulary. The policy-status adapter
narrows the inspector's verdict to `stale` (reason `policy-stale`) or
`unavailable` (`local-network-unavailable` and `policy-summary-invalid` alike,
plus any unreadable answer), and `RtspReadinessAdapter` maps those onto
`policy-stale` and `runtime-invalid`. Worker group membership is not something
the inspector can see: `runtime-group-incomplete` is an application-only reason,
decided before the policy is consulted, and the only one another restart can
fix by itself.

### Awaiting restart is expected control flow

Privileged success is durable but unproven — this process cannot pick up a group
it was just granted — so the job parks in `awaiting-restart`, keeping the active
slot, and is reconciled from its persisted phase alone. The root helper is never
consulted or started again for such a job.

```
running + privileged success                        → awaiting-restart(identity) → notify → dispatch
awaiting-restart + same identity                    → wait
awaiting-restart + new identity + ready             → terminal success → afterEnable → notify
awaiting-restart + new identity + group incomplete  → record identity → dispatch once
awaiting-restart + new identity + stale/invalid     → terminal failure + attention
```

Two invariants hold the shape together. No install is successful until a fresh
process passes readiness: nothing is enabled and no success is announced before
that. And the loop guard is one dispatch per distinct process identity, so a
recovery tick that fires every two seconds cannot restart the supervisor on
every pass. A dispatch failure keeps the phase, raises `restart-required`, and
throws `FeatureRestartDispatchError`; a later process recovers the same job.

### Reinstall restores narrowly

A reinstall re-runs the routine underneath an installation that was already
working, so letting the previous state simply stand again requires two
independent proofs: the reported cause is one of the pre-mutation codes
(`isPreMutationInstallFailure` — the request/publish/helper-version codes plus
`local-network-unavailable`, `network-policy-generation-failed`, and
`dependency-install-failed`), so no durable artifact was renamed; **and** the old
digest passes application readiness *now*, re-verified through the inspector
rather than trusted from what was stored before the attempt. Anything else —
`privileged-verification-failed` above all, and any mismatched artifact — stays
gated as `partial-state-uncertain` until a later reinstall or verification
reconciles all three files.

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
