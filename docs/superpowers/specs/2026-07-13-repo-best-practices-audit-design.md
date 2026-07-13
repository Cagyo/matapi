# Repo Best-Practices Audit & Refactoring Backlog

> **Date:** 2026-07-13 · **Type:** analysis spec (audit + prioritized backlog)
> **Scope:** whole repo (`home-worker`, NestJS + grammY on Raspberry Pi, ~27k LOC / 9 contexts)
> **Benchmarks:** the repo's own docs (`docs/architecture.md`, `naming-and-conventions.md`, `testing.md`, `error-handling.md`) **and** general software best practice for a TypeScript worker on constrained hardware.
> **Depth:** two passes — (1) breadth (metrics + targeted hotspot reads), (2) a deep read of the highest-risk critical paths (§2.8), line by line.

## 1. Executive summary

This is a **disciplined, well-documented codebase**. The hexagonal migration described as "in transition" in `docs/architecture.md` is effectively complete: the legacy folders the doc still calls "today" (`src/sensors/drivers`, `sensor.interface.ts`, `event.queue.ts`, `telegram/commands`) are all gone, `domain/` layers carry no infrastructure imports, there are zero `: any` occurrences in `src/`, one `console.*` (in a dev-only controller), and one `TODO` in the whole tree.

Consequently, an internal-rules audit comes back mostly green, and the highest-value findings are **structural**, not hygiene:

- **No P0 (correctness/security) defects surfaced in this pass.** Security in particular is strong — every shell call uses `execFile` with an argv array and a timeout; there is no command-injection surface.
- The concentration of debt is in the **Telegram interface layer**: two mega-handlers (`config.handler.ts` 1020 LOC, `camera.handler.ts` 912 LOC) that hand-roll multi-step conversation state machines inside the `interfaces/` layer — where an empty `flows/flow.engine.ts` stub and an unused `@grammyjs/conversations` dependency show the intended-but-unbuilt abstraction.
- A scattering of low-cost tooling/dependency hygiene items (loose `mqtt` pin, warn-level lint rules that should be errors, an unused dependency, a possibly-misplaced dev tool).

**The deep pass (§2.8) reinforced this conclusion rather than overturning it.** Reading the hardest code line by line — the 880-LOC live-stream concurrency core, the process-spawning tunnel adapter, the event/notification pipeline, the GPIO edge driver, the SQLite backup path — surfaced **no P0/P1 correctness defect**, and confirmed that the two classic trap areas are handled correctly: SQLite is snapshotted with the online `.backup()` API (WAL-safe), and stale-lease process kills are guarded against **PID reuse** via `/proc` start-time + `exe` identity before any signal. The deep pass produced three small, concrete items (an at-risk non-atomic backup write, two pieces of dead code) — none structural.

The backlog in §3 is anchored by one P1 refactor (unify conversation handling) with the cheap wins (§3, P2/P3) sequenced around it. No deep-audit finding displaces R1 as the top item.

## 2. Dimension scorecard

Legend: ✅ Strong · ⚠️ Gaps · ❌ Weak. Evidence is `path:line`.

### 2.1 Architecture & layering conformance — ✅ Strong (one smell)

The dependency rule holds. No `domain/` file imports Drizzle, grammY, pigpio, Nest `@Inject`, or `child_process`. Cross-context traffic goes through ports (e.g. `config.handler` depends on `SENSOR_QUERY` / `SensorQueryPort`, not the sensors table). Migration is done — no legacy layout remnants remain.

- ⚠️ **Orchestration state lives in `interfaces/`.** `config.handler.ts:96` holds `states = Map<number, ConfigState>` and drives a multi-step wizard via a global `message:text` listener (`config.handler.ts:139`) and a large `onText` switch (`config.handler.ts:491`). `camera.handler.ts:82-83` similarly holds `pendingBrowseInputs` / `browseLastResults`. Per `architecture.md`, `interfaces/` should "wire input → use-case parameters"; a stateful conversation FSM is application-layer orchestration. This is the root cause of the two largest non-data files. → **R1**.

### 2.2 Complexity & cohesion — ⚠️ Gaps

Real logic hotspots (locales excluded — those are translation data):

| File | LOC | Nature |
|---|---|---|
| `src/telegram/interfaces/config.handler.ts` | 1020 | routing + rendering + wizard FSM + validation in one class |
| `src/telegram/interfaces/camera.handler.ts` | 912 | 11-way subcommand switch + browse pagination state + rendering |
| `src/camera/application/live-stream-session.service.ts` | 880 | single global concurrency state machine (see §2.6) |
| `src/locales/{en,ru,uk}.ts` | ~1245 each | i18n data tables — acceptable, see R6 |

The first two are cohesion problems (multiple responsibilities per file); the third is inherent-complexity, recently hardened, and **should not be casually split** (see R12). → **R1, R3, R12**.

### 2.3 Testing strategy & coverage — ✅ Strong rubric, ⚠️ uneven

`docs/testing.md` is model-grade: three tiers mapped to layers, in-memory adapters over mocks, determinism rules, an explicit "every domain-error arm of every interface handler" target. 169 test files exist. Distribution is skewed toward the busiest contexts:

```
telegram 45 · sensors 35 · camera 30 · system 17 · events 16
network 6 · locales 5 · features 4 · setup-wizard 3 · database 3 · config 2
```

- ⚠️ **Directed check needed, not an assumed gap:** given `config.handler.ts` and `camera.handler.ts` each have large error→reply branch surfaces, verify their tests meet the documented per-error-arm target before R1 restructures them. → **R3**.
- ⚠️ No **locale-key-parity** test guarantees `en`/`ru`/`uk` stay in sync — a cheap safety net against missing translations. → **R6**.

### 2.4 Error handling, resilience & observability — ✅ Strong

- 65 files define typed error classes; 296 `catch` sites; boundary mapping is the documented pattern.
- Resilience is widespread: retry/backoff in `base-uart-co2.adapter`, `digital-gpio.adapter`, `drain-event-queue.use-case`, `notification.service`, `check-bot-polling.service`, `live-stream-session.service`; `autoRetry()` wired for Telegram rate limits (`grammy-bot.gateway.ts:218`).
- Every shell call carries an explicit `timeout` (§2.5).
- Observability: 103 `Logger` sites; only one `console.*` (`sensors/interfaces/dev-simulator.controller.ts:213`, a dev tool).
- 🟢 Optional enhancement: correlation IDs across event-queue → notification → telegram would aid on-device tracing. → **R11** (P3).

### 2.5 Security & least privilege — ✅ Strong

- **No command-injection surface.** All shell access uses `execFile` with an argv array and a timeout — never `exec(string)` and never `shell: true`. E.g. `motion-daemon.adapter.ts:32-68` (`execFile('systemctl', ['is-active', this.unit], { timeout })`), `rclone-drive-sync.adapter.ts:101` (`ionice -c3 rclone …`). `sudo` is confined to fixed `systemctl <unit>` argv.
- The `exec(` hits initially flagged in `logs.handler`, `csv.handler`, and `events/domain/quiet-hours.ts` are all `RegExp.exec()` — the `interfaces/` and `domain/` layers do **not** shell out. Correct.
- Secrets discipline per CLAUDE.md; `.env` gitignored.
- ⚠️ Minor: `no-explicit-any` and `no-console` are eslint **warnings**, not errors (`eslint.config.mjs:46,75`), so the CLAUDE.md "no any at boundaries / no console in production" rules are documented but not CI-enforced. Currently clean, but a regression would pass CI. → **R4**.

### 2.6 Performance & Pi resource budget — ✅ Mostly strong, ⚠️ one leak

- Pi-aware choices throughout: `ionice -c3` on rclone sync, timeouts on all external calls, streaming media adapters, PM2 `max_memory_restart=512M`.
- ⚠️ **Session-Map eviction is inconsistent.** `camera.handler` has a 10-min TTL and evicts on expiry (`camera.handler.ts:53,320`). `config.handler`'s `states` Map deletes **only** on explicit complete/cancel/back paths — an abandoned admin wizard entry lingers for the process lifetime. Blast radius is small (admin-only, and re-entry overwrites the entry), so severity is low, but the inconsistency should be closed. → **R2** (folds into R1).
- 🟢 26 sync fs/exec calls exist but are confined to boot/seed/one-shot paths (`config.loader`, `feature-seeder`, `dev-seeder`, `pid-lock.gateway`, `node-csv-temp-file.adapter`); one is in `quick-tunnel-live-stream.adapter` — worth a glance during R1-adjacent work but not a hot-path concern.

### 2.7 Dependency & tooling health — ⚠️ Gaps (all low-cost)

- ⚠️ **Unused dependency + dead stub.** `@grammyjs/conversations` (`package.json:31`) has **zero** usages in `src/`, and `src/telegram/flows/flow.engine.ts` is a **9-line empty stub** (`export class FlowEngine {}`) imported by nobody. The intended conversation abstraction was declared but never built. → **R1 / R5**.
- ⚠️ **Loose version pin.** `mqtt: "^5"` (`package.json:44`) allows any 5.x, unlike the minor-pinned rest of the manifest. → **R7**.
- ⚠️ **Possibly-misplaced tool.** `drizzle-kit` sits in `dependencies` (`package.json:41`); it is a codegen/migration CLI. If on-device `db:migrate` is not required (migrations can ship pre-generated), it belongs in `devDependencies` to shrink the Pi install. Verify against `scripts/dev-update.sh` first. → **R8**.
- 🟢 `tsconfig.json` already has `strict`, `strictNullChecks`, `noImplicitAny`, `noFallthroughCasesInSwitch`. Adding `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` would catch a further class of real bugs. → **R9** (P3, may surface fallout).

### 2.8 Deep-audit verification — critical paths — ✅ Verified correct

The breadth pass rated §2.4–§2.6 strong from signals (grep + metrics). The deep pass read the actual logic of the highest-consequence paths to confirm — or refute — those ratings. It confirmed them, and this section records *what was verified* so the ✅ ratings are trustworthy, not assumed. It also produced the three concrete items **R13–R15**.

| Path (file) | What a line-by-line read verified | Verdict |
|---|---|---|
| `camera/application/live-stream-session.service.ts` (880) | A single serialized queue plus a lease-mutation tail fences every transition; gateway start runs *outside* the queue so a stop can cancel a pending tunnel; timeouts convert to fenced "cleanup blockers" that never orphan; every detached `.then()` callback swallows to avoid unhandled rejections. Expiry uses `performance.now()` + libuv `setTimeout` — the **same monotonic base**, so the single non-rescheduling timer's guard (`clock.now() >= expiresMonotonicMs`) is not reachable-false in practice. | ✅ Correct (very high complexity — see R12) |
| `camera/infrastructure/quick-tunnel-live-stream.adapter.ts` (627) | `cloudflared` is spawned `detached`, `shell:false`; the code asserts the child is its **own** process-group leader and *not* the worker's group before trusting it. `recoverOwnedProcess` and `terminateVerifiedGroup` re-verify **process identity** (`/proc/{pid}` start-time + `exe` readlink) before **and** between SIGTERM→SIGKILL, and signal the whole group (`kill(-pid)`). This is a correct **PID-reuse guard** — a recycled PID mismatches identity → `not-owned`. | ✅ Correct (a classic trap, handled right) |
| `database/backup.service.ts` · `camera/infrastructure/sqlite-db-backup.adapter.ts` | Both use better-sqlite3's **online `.backup()`** — WAL-safe, non-blocking, no naive file copy. WAL pragmas (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`) and per-multi-write transactions are in place. | ✅ Snapshot correct — ⚠️ non-atomic *write* + dead dup → **R13** |
| `events/application/{notification,drain-event-queue}` | `process()` re-queues only when **every** non-suppressed send fails (a single blocked user does not wedge); the periodic drain then delivers an **aggregate broadcast** and force-attaches as a file past `maxQueueBeforeForceAggregate` (backpressure). A true wedge needs per-user *and* broadcast to fail permanently — i.e. the bot is down, which `isReady()` already gates. | ✅ At-least-once, bounded |
| `events/application/debounce.service.ts` | Suppresses only **byte-identical** repeats inside the window; every real transition fires; type/shape mismatches **fail open** (notify). Correct bias for a security worker. | ✅ Correct (fail-open) |
| `events/domain/quiet-hours.ts` | Overnight wrap (`start > end`) and same-day windows both correct; `HH:MM` bounds validated. | ✅ Correct |
| `sensors/infrastructure/digital-gpio.adapter.ts` (481) | Alarm/leak edges **rise fast** (`min(debounce, 50 ms)`) and **clear slow** (`max(debounce, 60 s)`); a re-trigger during the hold cancels the pending clear; hardware glitch filter + a >30-transitions/min circuit breaker that alerts the operator and drops to 10 s polled sampling. Timer lifecycle is cleaned on destroy/init. | ✅ Fail-safe biased — ⚠️ flap-cooldown gap → **R15**; dead field → **R14** |
| `camera/application/drive-sync.scheduler.ts` + `@Interval`/`@Cron` handlers | Every scheduled handler delegates to a `run()` wrapper with a re-entrancy `Set` and an internal `try/catch/finally` — no overlap, no unhandled rejection escaping a timer. | ✅ Correct |

**Net:** the critical paths are not merely clean, they are correct under adversarial reading. The deep pass's only new defects are R13 (a real, if narrow, robustness bug) and R14/R15 (dead code + one design tradeoff to ratify). None is structural; **R1 remains the top item.**

## 3. Prioritized refactoring backlog

Each item: `[tier] [effort S/M/L] [risk]` · *Why* · *Files* · *Done when*.

### P0 — Correctness / Security (do first)

**None.** No correctness or security defect surfaced — and this now rests on a **line-by-line read** of the critical paths (§2.8: concurrency core, tunnel process lifecycle, event pipeline, GPIO driver, SQLite backup), not only on metrics. The two classic traps (WAL-safe hot backup, PID-reuse-safe process kills) are handled correctly. Stated explicitly so the absence is a finding, not an omission. The nearest thing to a correctness bug is **R13** (non-atomic backup write), triaged P2 because it corrupts only a *derived* file (the DB backup), never live data.

### P1 — High-value structural

**R1 — Unify multi-step conversation handling; migrate the two mega-handlers onto it.** `[P1] [effort L] [risk M]`
*Why:* Resolves four things at once — the two largest non-data files (§2.2), orchestration state leaking into `interfaces/` (§2.1), the config-wizard eviction gap (§2.6/R2), and the unused-dep/dead-stub inconsistency (§2.7/R5). Decide the abstraction: **either** build out `flows/flow.engine.ts` into a real step/TTL-managed engine, **or** adopt the already-declared `@grammyjs/conversations`. Then move the FSMs out of `config.handler.ts` / `camera.handler.ts` into `telegram/application/` flows, leaving the handlers as thin wire-in/render layers.
*Files:* `src/telegram/interfaces/config.handler.ts`, `src/telegram/interfaces/camera.handler.ts`, `src/telegram/flows/flow.engine.ts`, `package.json`.
*Done when:* wizard/browse state no longer lives in `interfaces/`; both handlers materially smaller; the chosen abstraction has TTL eviction; behavior parity proven by the tests from R3.
*Risk note:* behavior-preserving refactor of user-facing flows — **land R3 first** as the safety net.

### P2 — Maintainability

**R2 — Give `config.handler` session state a TTL.** `[P2] [effort S] [risk L]`
*Why:* Match `camera.handler`'s eviction so abandoned admin wizards don't linger (§2.6).
*Files:* `src/telegram/interfaces/config.handler.ts`. *Done when:* stale `states` entries expire on a TTL. *Folds into R1 if R1 is done first.*

**R3 — Directed error-arm coverage audit of the two mega-handlers.** `[P2] [effort M] [risk L]`
*Why:* `testing.md` targets "every domain-error arm of every interface handler"; confirm `config.handler`/`camera.handler` meet it and fill gaps. Also the pre-refactor safety net for R1.
*Files:* `test/telegram/**`. *Done when:* every error→reply branch in both handlers has a test.

**R4 — Promote `no-explicit-any` and `no-console` from warn to error.** `[P2] [effort S] [risk L]`
*Why:* Enforce the CLAUDE.md rules in CI instead of documenting them (§2.5). Source is already clean; inline-disable the one dev-simulator `console.error`.
*Files:* `eslint.config.mjs`, `src/sensors/interfaces/dev-simulator.controller.ts`. *Done when:* `yarn lint` fails on a new `any`/`console` in production paths.

**R5 — Resolve the unused-dependency / dead-stub inconsistency.** `[P2] [effort S] [risk L]`
*Why:* Either adopt `@grammyjs/conversations` (via R1) or remove it; build out or delete the empty `flow.engine.ts` (§2.7).
*Files:* `package.json`, `src/telegram/flows/flow.engine.ts`. *Done when:* no declared-but-unused conversation dependency and no dead stub. *Coupled to R1.*

**R6 — Add a locale-key-parity test.** `[P2] [effort S] [risk L]`
*Why:* Guarantee `en`/`ru`/`uk` share identical key sets; cheap guard against missing translations (§2.3).
*Files:* `test/locales/**`. *Done when:* a test fails if any locale is missing/extra a key.

**R13 — Make the local DB backup write atomic, then delete the dead duplicate.** `[P2] [effort S] [risk L]` *(deep audit §2.8)*
*Why:* `SqliteDbBackupAdapter.createLocalBackup` runs `.backup()` **directly onto** `./data/backup.db`; a crash or failure mid-backup leaves a **partially-written, corrupt** file that the next Drive upload would ship. The unused `database/backup.service.ts` (`BackupService`, wired nowhere) already does the right thing — backup to `target.tmp` then atomic `renameSync`. Steal that pattern into the live adapter, then delete `BackupService`.
*Files:* `src/camera/infrastructure/sqlite-db-backup.adapter.ts`, delete `src/database/backup.service.ts`. *Done when:* an interrupted backup never corrupts `BACKUP_LOCAL_PATH`; no dead duplicate remains.

### P3 — Nice-to-have

**R7 — Pin `mqtt` to a minor range** like the rest of the manifest. `[P3] [effort S] [risk L]` · `package.json:44`.

**R8 — Verify `drizzle-kit` runtime need; move to `devDependencies` if unused on-device.** `[P3] [effort S] [risk L]` · Check `scripts/dev-update.sh` for on-device `db:migrate` before moving · `package.json:41`.

**R9 — Tighten `tsconfig`: add `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.** `[P3] [effort M] [risk M]` · May surface real fallout across `src/`; do as its own change · `tsconfig.json`.

**R10 — (Optional) Namespace locale files by feature.** `[P3] [effort M] [risk L]` · Low value; defer unless the files become a merge-conflict magnet · `src/locales/*`.

**R11 — Correlation IDs across event-queue → notification → telegram.** `[P3] [effort M] [risk L]` · Improves on-device tracing (§2.4).

**R12 — `live-stream-session.service.ts`: harden by test, not by splitting.** `[P3] [effort M] [risk M]`
*Why:* 880 LOC of deliberate concurrency coordination (promise-queue serializer `:94`, lease-mutation tail `:100`, cleanup blockers, expiry timer), recently hardened (commits `132ddc1`, `bd4e1f2`). Restructuring risks reintroducing the race/recovery bugs those commits closed. Instead raise use-case test coverage of the concurrency/recovery arms and, if a seam is clean, extract the promise-queue mutex as a named, independently-tested primitive.
*Files:* `src/camera/application/live-stream-session.service.ts`, `test/camera/**`.

**R14 — Remove the dead `lastEmittedAt` field from the digital GPIO adapter.** `[P3] [effort S] [risk L]` *(deep audit §2.8)*
*Why:* `digital-gpio.adapter.ts:53` assigns `lastEmittedAt` (`:412`) but never reads it — its debounce is timer/level-verified, not timestamp-based. The field is real (and used) only in `mqtt-sensor.adapter.ts`; here it is vestigial cruft.
*Files:* `src/sensors/infrastructure/digital-gpio.adapter.ts`. *Done when:* the unused field is gone.

**R15 — Ratify (or shrink) the flap-cooldown sampling gap for alarm-class sensors.** `[P3] [effort S–M] [risk L]` *(deep audit §2.8)*
*Why:* When a digital sensor trips the >30-transitions/min circuit breaker it drops to **10 s polled sampling for 5 min** (`FLAP_RECOVERY_MS`). During that window a real `alarm`/`leak_hazard` pulse shorter than ~10 s can be missed. The operator *is* alerted to the `flapping_fault`, so this is a deliberate tradeoff — but for a security worker it should be an explicit, documented decision, not an accident. Options: accept and document, or use a shorter poll for `alarm`/`leak_hazard` step types.
*Files:* `src/sensors/infrastructure/digital-gpio.adapter.ts`, `docs/specs/` (record the decision). *Done when:* the behavior is either documented as intended or tightened for alarm-class sensors.

## 4. Sequencing

```
Quick wins (parallel-safe, any time):   R4 · R6 · R7 · R13 · R14
Before the big refactor:                 R3  (test safety net for R1)
Anchor:                                   R1  (absorbs R2 + R5)
Decide, then act:                         R15 (ratify or tighten)
Independent, later:                       R8 · R9 · R11 · R12 · R10
```

- **R4, R6, R7, R13, R14** are isolated and low-risk — land them first to bank value. **R13** (atomic backup) is the highest-value quick win: it closes a real, if narrow, corruption path.
- **R3 precedes R1**: the coverage net makes the behavior-preserving refactor safe.
- **R1** is the centerpiece and folds in **R2** and **R5**.
- **R15** is a decision, not just code — ratify the flap-cooldown tradeoff (or tighten it for alarm-class sensors) before closing it.
- **R8, R9, R11, R12, R10** touch independent areas and can be scheduled whenever.
- **R12 is deliberately not a "split the big file" item** — the live-stream core is high-risk and was recently stabilized (confirmed correct in §2.8).

## 5. Non-goals

- No big-bang rewrite; every item is incremental per `architecture.md` migration policy.
- No folder-reshuffle-only PRs (the architecture doc forbids them).
- Locale *content* and translation quality are out of scope (only structure/parity).
- On-device deployment scripts (`scripts/*.sh`) are only touched where R8 requires verification.
