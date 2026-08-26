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

## Camera source mutations

Five typed errors cover everything a camera-source mutation can refuse with.
None of them echoes anything back, because all five reach a Telegram chat.

| Error | `code` | Means |
|---|---|---|
| `CameraNameTakenError` | `CAMERA_NAME_TAKEN` | Another camera already answers to the canonical key of the attempted name. The name is deliberately absent — echoing it back would confirm a camera the actor may not be allowed to know about. |
| `CameraIdCollisionError` | `CAMERA_ID_COLLISION` | A generated identifier is already stored. The colliding value is absent because the answer is to mint another one and retry. |
| `LiveSourceStateChangedError` | `LIVE_SOURCE_STATE_CHANGED` | The stored source moved between the caller's checks and its compare-and-swap: another mutation advanced the revision, an attach won the race, or the camera is gone. The caller re-reads and decides again. |
| `CameraSourceAdminRequiredError` | `CAMERA_SOURCE_ADMIN_REQUIRED` | The synchronous authorization fence denied. Also what an unregistered authorization registry and an unreadable `users` table both raise — the fence is fail-closed, and a denial carries no actor identity. |
| `CameraSourceUnavailableError` | `CAMERA_SOURCE_UNAVAILABLE` | RTSP went away mid-mutation. A `reason` discriminator separates the two conditions an admin can actually meet: `rtsp-closed` (feature disabled, policy reinstall, runtime teardown) and `session-stop-failed` (the camera could not be taken off air). |

`CameraSourceUnavailableError` is deliberately **not** `LiveStreamUnavailableError`:
that error means "the stream you asked to watch cannot start" and renders as
stream copy, which is the wrong thing to tell an administrator who was editing a
camera. `RtspSourceMutationService` translates at its own boundary — a
`LiveStreamUnavailableError` from the start gate becomes `rtsp-closed`, and any
throw out of `stopCamera` becomes `session-stop-failed` rather than being
allowed to carry runtime detail (or a `cause`) into a chat.

## Live-source probe failures

Every rejection of `LiveSourceProbePort.run` is one of eight kinds, all
extending `LiveSourceProbeBaseError`:

```
host-not-found · host-unreachable · authentication-rejected
tls-verification-failed · unsupported-stream · probe-timeout
address-outside-policy · probe-failed
```

Two rules hold the family together, and both are enforced rather than trusted:

1. **Every kind is parameterless.** No URL, host, address, `cause`, or raw
   process output. The probed URL carries the camera password and the message
   reaches an operator chat, so the *kind alone* is the payload.
2. **The union and the runtime recognizer cannot diverge.**
   [live-source-probe.port.ts](../src/camera/domain/ports/live-source-probe.port.ts)
   carries a compile-time assertion that `LiveSourceProbeError extends
   LiveSourceProbeBaseError`. Without it, a new member that failed to extend the
   base would silently downgrade to the generic failure at every `instanceof`
   catch site, and no test could notice. The Telegram advice map is keyed on the
   union, so an unhandled code is a build failure, not a fall-through.

Classification is a separate, stateless module —
[live-source-probe-diagnostics.ts](../src/camera/infrastructure/live-source-probe-diagnostics.ts)
— matching a fixed, ordered marker table against child diagnostics and throwing
the text away. Order is load-bearing (authentication before transport: a
rejected DESCRIBE also names the connection it arrived over). Every row owns a
fixture, and a guard walks the table to prove each fixture reaches its own row
rather than one an earlier marker shadows. `classifyProbeDiagnostics` is total
by construction: it runs inside an `execFile` callback, where a throw would cost
a PM2 restart.

### Known limitation — actionable advice is reduced on the sandboxed path

The marker table only ever sees FFmpeg's stderr, and the production path does
not have any. `systemd/homeworker-ffmpeg-stream@.service` sets
`StandardOutput=null` / `StandardError=null` **deliberately**, because ffmpeg
echoes the credentialed URL verbatim and routing stderr to journald would
persist camera passwords to disk. So on a sandboxed Pi a probe can only ever
classify:

```
host-not-found (resolver code) · address-outside-policy (containment)
probe-timeout (our own deadline) · probe-failed (everything else)
```

`authentication-rejected`, `tls-verification-failed`, `host-unreachable` and
`unsupported-stream` are reachable only on the unsandboxed developer path. The
"no sensitive diagnostics" half of the requirement is therefore fully met; the
"actionable" half is not, on the path that matters most. The follow-up is a
closed-vocabulary diagnostics token emitted by the sandboxed unit — a fixed
enum, never free text.

**Where the advice renders.** Whichever kinds a probe *can* classify, all eight
reach the administrator as advice rather than a generic failure. The
`camera.sources.probe` copy map is keyed by the error `code` and typed
`satisfies Record<LiveSourceProbeError['code'], string>`, so a missing or
mistyped key is a build error — the copy-side counterpart of the
`ProbeErrorsShareTheBase` assertion in `live-source-probe.port.ts`.
`CameraSourcesHandler.probeAdvice` renders it on both paths that probe: adding
or editing a source, and testing a stored one, each falling back to its own
generic message for a non-probe failure. Map from the `code`, never from
`DIAGNOSTIC_MARKERS` in `live-source-probe-diagnostics.ts` — that table is
infrastructure, exported only so a fixture-coverage guard can walk it.

So the reduction on a sandboxed Pi is in *classification*, not in rendering: the
kinds that survive are rendered as well as they can be, and the remaining four
render correctly the moment the follow-up makes them classifiable.

## Camera source prompt deletion

`CameraSourceMessagePort.delete` has exactly one way to refuse, and it is
declared **in the port file** rather than under `domain/errors/`:

```ts
// src/telegram/application/ports/camera-source-message.port.ts
export class CameraSourceMessageDeletionError extends Error {
  readonly code = 'CAMERA_SOURCE_MESSAGE_DELETION_FAILED' as const;

  constructor() {
    super('camera source message could not be deleted');
    this.name = 'CameraSourceMessageDeletionError';
  }
}
```

Both departures from the pattern at the top of this document are deliberate, and
neither generalises.

**Parameterless is the point, not an omission.** This is the same rule the
live-source probe errors follow, for the same reason: the message this error
names is a credential-bearing reply in an operator chat, and grammY's own
rejection quotes the chat and the message it refused. So the kind alone is the
payload — no `cause`, no chat id, no message id, no Telegram description. The
constructor captures nothing because there is nothing it could capture that the
caller is allowed to see. Its one consumer needs one bit (`deletionFailed`), and
that bit is what the tombstone records.

**Living beside its port is the exception, not a new home for errors.** Four
error classes in this repo are declared in a port file instead of
`domain/errors/`, across three ports — `DRIVE_FOLDER` (two), `CSV_TEMP_FILE`,
and `CAMERA_SOURCE_MESSAGE` — against 112 files under `domain/errors/`. Prefer
`domain/errors/`; treat that ratio as the rule. The narrow case for co-location
is a port whose refusal vocabulary is *small, closed, and part of reading the
interface* — `delete` either resolves or throws this one error, and no other
context throws or catches it. Once a family grows past that, or a second context
starts raising a member of it, move it into `domain/errors/` and leave the port
importing it.

**The port fails closed, which is why the error exists at all.**
`TelegramLiveStreamMessageCleanupAdapter` swallows a failed deletion; this
adapter must not, because its caller has to learn whether a credential is
actually gone in order to record that the deletion is still owed. An adapter
asked before a bot exists rejects too — "no bot" means the deletion did not
happen. A caller told "deleted" about a credential still sitting in a chat is
strictly worse than one told the truth.

**Quiet by design, at every layer above it.**
`RecoverCameraSourcePromptsUseCase` is a live example of the batched-use-case
rule above: it returns `{ attempted, failed, unfinished }` and never throws
mid-batch, isolating each *row* rather than only each deletion. It catches this
error without binding it, emits one count-only summary line for the whole pass,
and lets the retention sweep fail into a single warning rather than turning a
boot that did finish its cleanup into a rejected one.

## Presenting a camera-source failure

Every Camera and Features rejection that can reach the RTSP source screens goes
through one boundary —
[camera-source-error.presenter.ts](../src/telegram/interfaces/camera-source-error.presenter.ts)
— which turns it into an inert `{ kind, actions }`: a closed 13-member
`CameraSourceFailureKind` and a closed 4-member `CameraSourceRecoveryAction`.
No message, no `cause`, no URL, host, username, camera identity, policy digest,
or child diagnostic survives it. Callers render
`catalog.camera.sources.errors[kind]`, never `error.message`.

This is the same shape as the per-`if (err instanceof ...)` handler mapping
above, factored out for one reason: two screens classify the same failures, and
recovery is a property of the *kind* rather than of the error instance — two
callers that classify one failure must offer the same way out. `retry` appears
only where the identical request can succeed on a second attempt;
`change-address` wherever the address or credentials are a plausible cause;
`reinstall-rtsp` only for `policy-stale`, the one condition nothing inside the
screen can fix; `back` is last everywhere, so there is always one escape that
re-reads current state instead of acting on what the screen remembers.

Two rules keep it honest:

1. **Recognition is `instanceof` and closed discriminators only.** Nothing is
   parsed out of a message. Subclasses are matched *above*
   `LiveSourceProbeBaseError`, so a specific probe kind is never shadowed by its
   own base. An error the table does not know becomes the generic
   `probe-failed` — the least specific answer rather than a leaky one.
2. **It is deliberately lossy at the top of the table.**
   `CameraSourceAdminRequiredError` and `CameraSourceUnavailableError` do not
   round-trip through it; `CameraSourcesHandler` keeps `requireAdmin` and its
   unavailable reply *ahead* of the presenter, because "you are not an
   administrator" and "RTSP is not usable right now" are answers about the
   workflow, not about a source. Do not "complete" the mapping by adding kinds
   for them — that moves the two answers behind a screen that should never have
   been reached.

**The copy cannot go missing.** `LocaleCatalog` is `typeof en`, so every locale
carries the whole English shape; `camera.sources` is mandatory and key-identical
in English, Russian and Ukrainian, with **no fallback**. It used to be optional
so translations could land later — it no longer may, because that workflow asks
an administrator to paste an address carrying a camera password, and an
administrator who cannot read the warning cannot consent to it. A missing or
mistyped key is now a build failure rather than a silent English string in a
Ukrainian chat.

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
