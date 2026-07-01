# Code Audit — Home Worker

> Date: 2026-05-30 · Scope: full `src/` deep read (278 TS files, ~13.7k LOC) plus root config.
> Severity bar: Critical / High / Medium. Fixes are **proposed only** — no source was modified.

## How to read this report

Every finding below was **verified against the actual source** (file + line). A
separate [§ False positives](#false-positives-claims-that-do-not-hold) section
debunks plausible-but-wrong issues so they are not re-filed later. The most
important headline:

- **No remotely-exploitable Critical was found.** The Motion hook HTTP server
  binds to `127.0.0.1` ([src/main.ts](../src/main.ts#L73)), Telegram commands
  are role-gated, and OTA/system scripts are only reachable through admin
  commands. The two Critical-tier items are *local-injection / defense-in-depth*
  hardening gaps, not open doors.
- Hexagonal layering is **clean**: no `domain/` or `application/` file imports
  Drizzle, grammY, `node:child_process`, or `infrastructure/`. SQLite pragmas
  (WAL, `busy_timeout=5000`, `foreign_keys=ON`) are correctly set
  ([src/database/integrity.ts](../src/database/integrity.ts#L17-L23)).

---

## Summary table

| # | Severity | Area | Finding | File |
|---|----------|------|---------|------|
| C1 | Critical | Security | Media paths from DB read & served with no containment to `MOTION_LOCAL_DIR` | [get-motion-video.use-case.ts](../src/camera/application/get-motion-video.use-case.ts#L37) |
| C2 | Critical | Security | `deleteFile`/cleanup accept arbitrary DB-sourced paths → can delete files outside the media dir | [fs-local-storage.adapter.ts](../src/camera/infrastructure/fs-local-storage.adapter.ts) |
| H1 | High | Reliability | `EventProcessorService` fans out events with **unbounded concurrency** (no in-flight cap) | [event-processor.service.ts](../src/events/application/event-processor.service.ts#L26-L36) |
| H2 | High | Reliability | Motion-hook `file` query param stored verbatim, no path validation | [motion-hooks.controller.ts](../src/camera/interfaces/motion-hooks.controller.ts#L38-L66) |
| H3 | High | Concurrency | `SensorRegistryService.reload()` is not serialized; concurrent calls interleave at `await` points | [sensor-registry.service.ts](../src/sensors/application/sensor-registry.service.ts#L64-L114) |
| M1 | Medium | Duplication | GPIO-pin extraction logic duplicated in **5+ places** | see finding |
| M2 | Medium | Dead code | Compiled `drizzle.config.js` + `.map` committed alongside the `.ts` source | repo root |
| M3 | Medium | Antipattern | `GrammyBotGateway` constructor injects ~35 deps (god object / composition-root smell) | [grammy-bot.gateway.ts](../src/telegram/infrastructure/grammy-bot.gateway.ts#L71-L110) |
| M4 | Medium | Type safety | Config loaders cast YAML with `as` and no runtime validation | [config.loader.ts](../src/config/config.loader.ts#L18-L22) |
| M5 | Medium | Reliability | `DebounceService.lastNotified` map never evicts removed sensors | [debounce.service.ts](../src/events/application/debounce.service.ts#L13) |
| M6 | Medium | Reliability | Scheduler/UART re-entrancy guards never reset if a task hangs past its IO timeout | [drive-sync.scheduler.ts](../src/camera/application/drive-sync.scheduler.ts#L53-L70) |
| M7 | Medium | Observability | Hook & adapter catch-blocks log only `err.message`, dropping stack/cause | multiple |

---

## Critical

### C1 — Media file paths are served without containment to `MOTION_LOCAL_DIR`

[get-motion-video.use-case.ts](../src/camera/application/get-motion-video.use-case.ts#L37-L52),
[get-motion-photo.use-case.ts](../src/camera/application/get-motion-photo.use-case.ts)

`event.videoPath` / snapshot path is read from the DB and passed straight to
`files.exists(path)` → the file is streamed to the requesting admin. There is no
check that the resolved path stays inside `MOTION_LOCAL_DIR`. Those DB rows are
populated by the Motion-hook `file` query parameter (C-tier source, see H2), so a
single malicious/misconfigured local write of `../../../home/pi/.env` becomes an
arbitrary-file read that the bot will happily forward to Telegram.

**Why Critical not High:** it chains DB-write → admin exfiltration of any file the
worker user can read (`.env` contains `TELEGRAM_BOT_TOKEN`). Loopback binding
limits the *injection* vector but not the blast radius once a row exists.

**Proposed fix:** add a single guard used by every media read/serve/delete path:

```ts
import { resolve, sep } from 'node:path';
function assertInside(baseDir: string, candidate: string): string {
  const base = resolve(baseDir);
  const full = resolve(base, candidate);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new MediaFileUnavailableError(/* … */);
  }
  return full;
}
```

Apply it in `get-motion-video`, `get-motion-photo`, `fs-media-file`, and
`fs-local-storage` before any `fs` call.

### C2 — Local-storage cleanup deletes whatever path the DB hands it

[fs-local-storage.adapter.ts](../src/camera/infrastructure/fs-local-storage.adapter.ts),
driven by [cleanup-local-storage.use-case.ts](../src/camera/application/cleanup-local-storage.use-case.ts)

`deleteFile(path)` calls `fs.unlink`/`rm` on a DB-sourced path with no
containment check. Same injection source as C1, but the consequence is
*destructive* (file removal during the hourly cleanup loop) rather than
read-only. A traversal path persisted by the Motion hook could delete files
outside the media directory.

**Proposed fix:** reuse the `assertInside(MOTION_LOCAL_DIR, path)` guard from C1
at the top of `deleteFile`/`pruneDir`; log-and-skip on rejection instead of
throwing so cleanup keeps running.

---

## High

### H1 — Unbounded event fan-out concurrency

[event-processor.service.ts](../src/events/application/event-processor.service.ts#L26-L36)

```ts
this.sensorEvents.onEvent((event) => {
  if (this.shuttingDown) return;
  this.inFlight += 1;
  void this.handle(event).catch(/*…*/).finally(() => { this.inFlight -= 1; });
});
```

Each sensor event spawns a detached `handle()` promise with **no concurrency
limit**. A chattering GPIO line or a reconnect burst can launch hundreds of
concurrent `handle()` chains (each doing a `SensorQuery.findById` + enqueue),
spiking memory against the 512 MB PM2 ceiling. `inFlight` is only used for
shutdown draining, not back-pressure.

> Note: the counter itself is **not** a data race — Node is single-threaded and
> `+=`/`-=` are atomic w.r.t. each other (see False Positives). The real problem
> is *fan-out without a bound*.

**Proposed fix:** serialize through a small async queue (e.g. a 1-deep promise
chain, or `p-limit(1..2)`), so events are processed in order with bounded
in-flight work. This also removes the ordering ambiguity around `persistState`.

### H2 — Motion-hook `file` parameter is trusted verbatim

[motion-hooks.controller.ts](../src/camera/interfaces/motion-hooks.controller.ts#L38-L66)

`@Query('file')` is forwarded to `recordEnd.execute(camera, file)` /
`recordSnapshot.execute(file)` and persisted unmodified. Although the endpoint is
loopback-only, persisting an unvalidated filesystem path is the root of C1/C2.

**Proposed fix:** validate at the boundary — require the path to resolve inside
`MOTION_LOCAL_DIR` and match an expected `*.mp4`/`*.jpg` extension before
recording; otherwise log-and-ack (the handler already returns `{ ok: true }`
on failure, so Motion is unaffected).

### H3 — `reload()` is not re-entrancy-safe

[sensor-registry.service.ts](../src/sensors/application/sensor-registry.service.ts#L64-L114)

`reload()` is invoked from `onModuleInit` and from the add/modify/remove/import
use cases. It `await`s `repository.loadEnabled()` and per-driver `init()`, so two
overlapping calls **can interleave at those await points** (this is a real
interleaving hazard in single-threaded JS, unlike the false "counter races"). The
result: a driver can be initialised twice for the same pin, or destroyed while
another pass is iterating `this.active`.

**Proposed fix:** guard with a simple promise chain so reloads run sequentially:

```ts
private reloadChain: Promise<void> = Promise.resolve();
reload(): Promise<void> {
  this.reloadChain = this.reloadChain.then(() => this.doReload()).catch(/*log*/);
  return this.reloadChain;
}
```

---

## Medium

### M1 — GPIO-pin extraction duplicated 5+ times

Same `config.pin → number | null` logic appears in:
[sensor-registry.service.ts](../src/sensors/application/sensor-registry.service.ts#L168),
[digital-gpio.adapter.ts](../src/sensors/infrastructure/digital-gpio.adapter.ts#L109),
[drizzle-sensor.repository.ts](../src/sensors/infrastructure/drizzle-sensor.repository.ts#L174),
[add-sensor.use-case.ts](../src/sensors/application/add-sensor.use-case.ts#L78),
[modify-sensor.use-case.ts](../src/sensors/application/modify-sensor.use-case.ts#L60),
[config-import.ts](../src/sensors/domain/config-import.ts#L147).
Three of them are full helper functions (`extractPin`/`getPin`) with subtly
different signatures (`Record<string, unknown>` vs `unknown`).

**Proposed fix:** one domain helper, e.g. `GpioPin.fromConfig(config): number | null`
in [gpio-pin.value-object.ts](../src/sensors/domain/gpio-pin.value-object.ts), and
delete the copies.

### M2 — Compiled `drizzle.config.js` committed next to the `.ts` source

Repo root contains `drizzle.config.ts` **and** its build artifacts
`drizzle.config.js` + `drizzle.config.js.map` (verified identical logic via
`diff`). The `.js`/`.map` are stale-prone duplicates of the source of truth.
`scripts/setup-wizard/index.js` is the same pattern (compiled from `index.ts`).

**Proposed fix:** delete the generated `drizzle.config.js`/`.map`, point tooling
at the `.ts` (drizzle-kit reads `.ts` directly), and add `drizzle.config.js*`
to `.gitignore`. Decide deliberately whether `setup-wizard/index.js` must stay
committed for token-free execution; if so, document it, otherwise gitignore it.

### M3 — `GrammyBotGateway` is a god object

[grammy-bot.gateway.ts](../src/telegram/infrastructure/grammy-bot.gateway.ts#L71-L110)

The constructor injects ~35 collaborators (every handler + several application
services) and also owns the bot lifecycle, mock/real mode selection, and the
notifier registration wiring. It conflates the **composition root** with a
runtime gateway.

**Proposed fix:** introduce a `TELEGRAM_HANDLERS` multi-provider array (all
handlers implement the existing `TelegramHandler` interface) and inject the
single array, then `for (const h of handlers) h.register(composer)`. This drops
the constructor to a handful of params and makes adding a command a pure
registration change.

### M4 — YAML configs cast without runtime validation

[config.loader.ts](../src/config/config.loader.ts#L18-L22) does
`parse(text) as DefaultsConfig` with no schema check; a missing/renamed key
surfaces as `undefined` deep in the notification path rather than at boot.
Similar `as` casts exist in [shell-system-deps.adapter.ts](../src/system/infrastructure/shell-system-deps.adapter.ts#L160).

**Proposed fix:** validate `defaults.yml` with a small Zod schema at load time
and fail fast with a clear message. (`yaml.parse` itself is safe — no code-exec
tags — so this is integrity, not security.)

### M5 — Debounce map retains removed sensors

[debounce.service.ts](../src/events/application/debounce.service.ts#L13) — the
`lastNotified` map keys on `sensorId` and is never pruned. Bounded by sensor
count (so not the "unbounded leak" a quick scan suggests), but deleted sensors
leak a small entry forever.

**Proposed fix:** drop the entry when a sensor is removed (hook into
`remove-sensor.use-case`), or lazily evict on `reload()`.

### M6 — Re-entrancy guards never reset on a hung task

[drive-sync.scheduler.ts](../src/camera/application/drive-sync.scheduler.ts#L53-L70)
adds to a `running` Set in `try/finally`. The `finally` only fires when the task
settles; the underlying `rclone` has a **30-minute** timeout
([rclone-drive-sync.adapter.ts](../src/camera/infrastructure/rclone-drive-sync.adapter.ts#L17)),
so a half-open network can block that loop for up to 30 min. Same shape for the
UART read loop.

**Proposed fix:** lower the rclone timeout to ~10–15 min and/or wrap each
scheduled task in a `Promise.race` watchdog that always clears the guard.

### M7 — Catch-blocks discard stack/cause

Numerous adapters/handlers log `(err as Error).message` only
(e.g. [motion-hooks.controller.ts](../src/camera/interfaces/motion-hooks.controller.ts#L48),
[sensor-registry.service.ts](../src/sensors/application/sensor-registry.service.ts#L57)).
On a Pi, losing the stack/cause makes field debugging hard.

**Proposed fix:** pass the `Error` object to the Nest logger
(`this.logger.error(msg, err.stack)`), which preserves the trace, for at least
the IO-boundary catches.

---

## False positives (claims that do **not** hold)

Filed here so they are not re-investigated:

- **“Missing `await` on `db…​.run()` / `.get()` loses writes.”** *False.*
  `better-sqlite3` is **synchronous**; Drizzle's `.run()/.get()/.all()` execute
  immediately. The `async` method signatures are interface conformance, not
  pending IO. Writes in
  [drizzle-sensor.repository.ts](../src/sensors/infrastructure/drizzle-sensor.repository.ts#L29-L33)
  and [drizzle-event.repository.ts](../src/events/infrastructure/drizzle-event.repository.ts)
  are durable.
- **“`inFlight++ / --` is a data race” / “`isDraining` flag races” / “pigpio
  `connectPromise` races.”** *False.* Node.js is single-threaded; each guard is
  set synchronously before the first `await`, so no two callers observe a stale
  value. (The genuine concurrency hazard is H3, which interleaves *across* await
  points and corrupts a shared `Map`.)
- **“Application layer imports grammY (boundary violation).”** *False.* grammY is
  only imported under `interfaces/` and `infrastructure/`; `application/` and
  `domain/` are clean (verified by scoped grep).
- **“`yaml.parse` enables deserialization RCE.”** *False.* The `yaml` package
  does not execute tags by default.
- **“Bot token leaks via `import-config.handler`.”** *Low, not Critical.* The
  token is read from env into an instance field and used to build the standard
  Telegram file-download URL; it is **not logged** (the catch logs the `Error`
  object, which for `fetch` failures does not embed the URL). Still worth a
  defensive `URL`-redaction helper if any logging is added later.

---

## Test coverage observations

Coverage is broad (≈130 spec files, most use cases + adapters covered). Gaps
worth closing, aligned to the findings above:

- No test asserts **path containment** for media serve/delete (C1/C2) — add once
  the guard exists.
- No test exercises **concurrent `reload()`** (H3) or **event fan-out under a
  burst** (H1).
- [config.loader.ts](../src/config/config.loader.ts) has a test, but none for the
  malformed-YAML / missing-key path (M4).
- `GrammyBotGateway` has no direct unit test (hard to test as a god object — M3
  refactor would make handler registration testable).

---

## Suggested remediation order

1. **C1 + C2 + H2** together — one shared `assertInside()` guard closes the
   path-traversal chain end-to-end.
2. **H3** — serialize `reload()` (small, high-value, prevents driver/pin
   corruption).
3. **H1** — bound event fan-out.
4. **M1 / M2 / M3** — duplication & dead-code cleanup (low risk, improves
   maintainability).
5. **M4–M7** — hardening and observability.
