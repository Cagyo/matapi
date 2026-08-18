# Raspberry Pi 5 GPIO Support — libgpiod CLI Backend

**Date:** 2026-08-18
**Status:** Approved design, not yet implemented
**Affects:** `src/sensors/`, `src/features/infrastructure/readiness/`, `scripts/install.sh`, `scripts/install-feature.sh`, `scripts/feature-installer.py`, `config/system-deps.yml`

## Dependencies

- [02-sensor-core.md](../../specs/02-sensor-core.md) — `SensorDriverPort`
- [03-sensor-digital.md](../../specs/03-sensor-digital.md) — step types, debounce policy, circuit breaker
- [25-install.md](../../specs/25-install.md) — installer and root helper bundle
- [architecture.md](../../architecture.md), [ports-and-adapters.md](../../ports-and-adapters.md)

## Problem

Digital GPIO sensors reach the hardware through `pigpiod` over a TCP socket, via the
`pigpio-client` package. This cannot work on a Raspberry Pi 5: its GPIO sits behind the
RP1 southbridge, and pigpio does not recognise the BCM2712 revision code, so the daemon
aborts at startup. Every other feature deploys and runs normally; only GPIO sensors are
dead, and the installer currently reports that honestly rather than claiming success.

pigpio is also unmaintained. The kernel's supported interface is the gpiochip character
device, reached through libgpiod, which works on Pi 3, 4 and 5 alike.

## Decisions

**1. One backend for every Pi model.** Pi 3 and Pi 4 migrate off pigpio too, rather than
carrying two GPIO code paths indefinitely. The boards are available for verification.

**2. Reach libgpiod through its CLI tools as supervised subprocesses** — `gpiodetect`,
`gpioinfo`, `gpioget`, `gpiomon` from the `gpiod` apt package — not through a native
Node binding.

Every native binding on npm today is disqualified for this fleet:

| Package | Blocker |
|---|---|
| `node-libgpiod` | libgpiod 1.x only; README states 2.x support is still in progress. Breaks on Raspberry Pi OS Trixie, which ships 2.x. |
| `opengpio` | libgpiod 2.x only; its install docs instruct adding Debian **sid** to apt sources. Unacceptable in an appliance installer. |
| `@iiot2k/gpiox` | Prebuilt but **arm64-only** — excludes 32-bit Pi 3 images. No public repository. |

A hand-rolled N-API binding would have to target both the libgpiod 1.x and 2.x C APIs,
which are incompatible — strictly worse than shaping CLI arguments. The `gpiod` CLI
package is in apt on every Raspberry Pi OS release (bookworm 1.6.3, trixie 2.x), on both
32- and 64-bit. This repository already drives hardware through subprocesses:
`libcamera.backend.ts`, motion, ffmpeg, cloudflared.

Accepted cost: the kernel uAPI permits `GET_VALUES` on the same file descriptor that
holds an edge request, giving zero-gap resync. The shipped CLIs do not expose this. We
forfeit it deliberately and revisit only if field data shows missed alarms.

**3. Migration ships through `scripts/install.sh`**, not through the Telegram feature
system. See [Migration](#migration).

### Rejected: `GPIO_BACKEND=auto` transitional shim

Considered because neither `update.sh` nor `system-update.sh` installs new apt packages
or runs `usermod`, so an OTA could in principle land a gpiod-only backend on a box with
no `gpiod` package and a worker outside the `gpio` group.

Rejected because the root helper bundle already prevents exactly that. See
[Migration](#migration) — `update.sh` refuses the update with exit 3 until a local root
`install.sh` run lands the matching helper bundle. Code and runtime dependencies
therefore arrive together, and there is no silent window in which alarm sensors are dead
and nobody is told. The shim would buy nothing and cost a second live code path.

## The kernel fact that drives the design

**gpiochip line requests are exclusive.** `gpioget` on a line currently held by
`gpiomon` fails with `EBUSY`. pigpiod never exposed this, because the daemon owned every
line and multiplexed access internally. Three consequences shape the whole backend:

1. **Orphaned monitors hold lines indefinitely.** PM2's `max_memory_restart` can
   `SIGKILL` the worker; children are reparented and survive. A `gpiomon` on a *quiet*
   alarm line writes nothing, so it never hits `EPIPE` — it holds that line forever, and
   the restarted worker gets `EBUSY` on its own pins.
2. **No read-while-monitoring.** `read()` must serve from cache while a monitor is alive.
3. **Every (re)bind has a blind window.** The order `gpioget` → spawn `gpiomon` → confirm
   attach is forced; you cannot read after attach. That is roughly 30 ms on a Pi 3.
   `bindGpio` already has this race at ~1 ms today; the CLI widens it and adds one
   occurrence per monitor restart.

## Architecture

### The seam

`PigpioGateway` is replaced by an explicit interface plus a DI token, in
`src/sensors/infrastructure/gpio-backend.port.ts`.

```ts
export const GPIO_BACKEND = Symbol('GPIO_BACKEND');

export type GpioBias = 'up' | 'down' | 'none';

export interface GpioBackendState {
  available: boolean;
  generation: number;
}

export interface GpioLine {
  /** Record the request config; applied to each subsequent gpioget/gpiomon invocation. */
  configure(options: { bias: GpioBias; debounceUs: number }): Promise<void>;
  read(): Promise<0 | 1>;
  watch(onLevel: (level: 0 | 1) => void): Promise<void>;
  unwatch(): Promise<void>;
}

export interface GpioBackendPort {
  connect(): Promise<void>;
  isAvailable(): boolean;
  state(): GpioBackendState;
  onStateChange(listener: (state: GpioBackendState) => void): () => void;
  /** Canonical per-offset singleton. Two handles for one offset would self-EBUSY. */
  line(pin: number): GpioLine;
  close(): Promise<void>;
}
```

**Placement is infrastructure, not `domain/ports/`.** Its only consumer,
`DigitalGpioAdapter`, is itself infrastructure, and `configure({ bias, debounceUs })` is
transport vocabulary. The precedent is `MqttConnectionPool`, an injected infrastructure
utility rather than a domain port. The interface earns its existence by making the
adapter's test fakes type-checked — they currently rely on
`as unknown as PigpioGateway` structural casts.

This overturns the `ports-and-adapters.md` ruling that `PigpioGateway` should stay a
gateway; that row is rewritten rather than silently contradicted.

### Changes from the current six-operation surface

| Current | New | Reason |
|---|---|---|
| `modeSet('input')` | dropped | `gpioget`/`gpiomon` request input inherently. A call that means nothing is worse than no call. |
| `pullUpDown(0\|1\|2)` + `glitchSet(us)` | `configure({ bias, debounceUs })` | Deletes `pudCode()` and the pigpio PUD integer encoding from the adapter. Bias and debounce are properties of a libgpiod *request*, not mutable settings, so one call per request config is the honest shape. |
| `notify(cb): void` | `watch(cb): Promise<void>` | Spawning and confirming attach is genuinely async. Fire-and-forget would hide bind failures. |
| `connected` | `available` | No daemon socket to lose. |

`GpioPin` (BCM number) is unchanged: offsets 0–27 on all three pinctrl chips are BCM
0–27.

### `generation` semantics

`generation` bumps **only** on backend-level failure → recovery: tools removed, `gpio`
group membership lost, chip renumbered by a kernel update. Per-line monitor respawns are
invisible to `DigitalGpioAdapter`; the backend absorbs them and re-delivers a reconciled
level through the same `watch` callback.

This is what stops one flapping sensor from forcing a full rebind — and a fresh blind
window — on every other sensor. Systemic failures still flow through the adapter's
existing generation and rebind machinery unchanged.

## `LibgpiodCliBackend`

### `connect()`

1. Resolve absolute tool paths using the sanitized-`PATH` pattern from
   `readiness-seams.ts`.
2. Detect the libgpiod major **once** via `gpiodetect --version`; select a v1 or v2
   argument builder. Never sniff per invocation.
3. Resolve the chip **by label**, never by index: `pinctrl-bcm2835` (Pi 0–3, Zero 2),
   `pinctrl-bcm2711` (Pi 4, CM4), `pinctrl-rp1` (Pi 5, 500, CM5). `GPIO_CHIP` env
   override for exotic carriers. Hardcoding an index is precisely the failure Pi 5
   invites — the RP1 chip moved between `gpiochip4` and `gpiochip0` across firmware
   releases.
4. Run `gpioinfo <chip>` to prove the **effective** permissions of the running process,
   not merely that a device node exists.
5. Run the orphan sweep.

Line names are used only as an advisory cross-check in logs, never for addressing: older
Pi 3/4 device trees named header lines functionally (`ID_SDA`, `SPI_CE0_N`) rather than
`GPIOn`.

### One monitor per sensor

Not one multiplexed monitor per chip. Three independent reasons:

- The CLI applies request config (bias, debounce) to **every line in an invocation** —
  neither version supports per-line config. Mixed pulls cannot share a process anyway.
- The circuit breaker detaches *one* line's interrupt while others keep running
  (spec 03). Under a shared monitor that means restarting the request with N−1 lines,
  opening a stale window for every innocent sensor.
- Dynamic add and remove at runtime becomes kill-one/spawn-one.

Memory is not a concern: `gpiomon` is a small dynamically-linked C tool, roughly 1–2 MB
RSS mostly shared pages, and PM2's 512 MB cap watches the worker's own RSS, not children.

### Bind sequence

```
gpioget (initial level)  →  spawn `stdbuf -oL gpiomon …`  →  confirm attach via gpioinfo consumer poll
```

`stdbuf -oL` because C stdio block-buffers when stdout is a pipe. `gpiomon` probably
flushes per event, but an alarm path must not rest on "probably". `stdbuf` is coreutils,
present on every Raspberry Pi OS image, and a no-op if gpiomon already flushes.

Attach is confirmed by polling `gpioinfo` for the line's consumer field, bounded (for
example 10 attempts at 50 ms). This works on both versions; v1 prints nothing at startup,
so it is the only positive attach signal there.

### Respawn

Backoff ladder `[1s, 2s, 5s, 10s, 30s]`, mirroring `PIGPIO_RECONNECT_DELAYS_MS`. Before
each respawn, a reconciliation `gpioget` runs and its level is pushed through the `watch`
callback, so a transition during the blind window still lands.

**Ordering hazard: stale buffered stdout.** `exit` fires while the pipe may still hold
unread event lines. If respawn keys off `exit` and pushes the reconcile level before the
old stream's remaining `data`/`close` delivery, stale edges arrive *after* the reconcile
push and corrupt state until the next real edge. Fix: tag events per incarnation inside
the backend — the same pattern as `handleNotify`'s generation guard, one level down —
discard events from dead incarnations, and wait for stream `close` before the reconcile
read.

### Failure classification

| Condition | Treatment |
|---|---|
| `EBUSY`, consumer is ours (orphan) | Transient — sweep, retry |
| `EBUSY`, **foreign** consumer | Retry forever on a slow (~60 s) ladder; the foreign consumer may release. Surface the consumer name and report the line unhealthy. |
| `gpiomon` crash / non-zero exit | Retry forever on the capped ladder |
| `ENOENT` / `EACCES` on the chip | Backend-level: drop `available`; bump `generation` on recovery |
| Config invalid | Terminal — the only terminal class |

**Alarm lines never stop retrying.** "N attempts then terminal" is wrong for
`leak_hazard` and `alarm`; the health and attention layers report the fault instead.

A foreign consumer is a failure class pigpiod's shared model hid entirely — another
`gpiomon`, a dtoverlay, gpiozero. Its name must reach the operator.

`read()`:

- unmonitored → real `gpioget` (exactly the circuit breaker's 10 s polled path)
- monitored → cached last level, **bounded by a staleness threshold**
- throws on terminal classification, and when the cached level exceeds the staleness
  bound — never merely because a respawn is in flight

The staleness bound is required: without it a line whose monitor died and is still
climbing the backoff ladder would serve an indefinitely old value, and `healthCheck()`
would report a dead sensor as healthy. The bound is what makes the
`healthCheck()`-clears-`offline` fix below necessary rather than merely defensive — the
two changes only work as a pair.

Per-line failures never poison backend state.

### Orphan sweep — correctness, not optimization

Three reasons it cannot be treated as best-effort: shutdown-budget overruns leak children
by design (`completeWithinDriverShutdownContext` returning `cancelled`); PM2 `SIGKILL`
leaks them; and a monitor on a quiet alarm line never writes, never hits `EPIPE`, and
holds its line indefinitely. The bind and `read()` paths have no retry ladder of their
own, so the startup sweep protects them.

Identification is by **full argv signature** — chip, offset, and our pinned format string
together are distinctive. On v2 we additionally pass `--consumer home-worker-<pin>` for an
unambiguous marker in `gpioinfo`. **v1 tools have no `--consumer` flag**; the consumer is
the fixed string `gpiomon`, indistinguishable from an administrator's manual invocation,
so argv matching is the primary mechanism there. A PPID==1 heuristic is explicitly *not*
relied upon — orphans may reparent to a `systemd --user` instance rather than init.

Startup sweep and on-`EBUSY` recovery are both retained; both are correctness.

### Version strategy

Two pure argument builders and output parsers behind one internal interface, selected
once at `connect()`.

- v1: `gpiomon [opts] <chip> <offset>…`, `gpioget <chip> <offset>…` printing bare `0`/`1`
- v2: `--chip <chip>` with offsets; `gpioget` prints `"GPIO17"=inactive` without
  `--numeric`
- `--debounce-period` is **v2 only**. On v1, `debounceUs` is logged once and ignored. This
  is acceptable: the JS debounce already produces correct output for sub-threshold
  glitches (a candidate that reverts clears its timer and emits nothing), and the hardware
  filter was CPU protection, which the circuit breaker covers.
- Both support `--bias=pull-up|pull-down|disabled`; `none` maps to `disabled`.
- Event format is pinned explicitly on both (`-F` / `--format`); default output is never
  parsed.
- Event timestamps are ignored — `handleNotify` uses `Date.now()`, and clock semantics
  differ across versions and kernels.

**`-l` / `--active-low` is never passed.** Inversion stays in the adapter's `mapValue()`,
so the backend delivers raw levels exactly as pigpio's `notify` did.

## `DigitalGpioAdapter` changes

All policy — the debounce table, circuit breaker, timer lifecycle, generation guards —
is unchanged. Churn is rename-level except for two deliberate edits.

### 1. `healthCheck()` success clears `offline`

There is a latent bug on the pigpio path today. `handleNotify` drops every event while
`this.offline` is true, and **only** `bindGpio` clears `offline`. `healthCheck()` sets
`offline = true` on any `read()` throw. A transient read failure with no generation bump
therefore leaves that sensor **permanently deaf**.

Under the new backend this becomes reachable through per-line recovery, which by design
does not bump the backend generation. The fix is one policy touch: a successful
`healthCheck()` clears `offline`, paired with the backend re-emitting the current level
after each line recovery.

This is the single intentional behavioural change to the adapter and must be called out
in review.

### 2. `await watch()` atomicity contract

`bindGpio`'s tail is currently **synchronous** from the last `await` through
`gpio.notify(...)`, so it is atomic against a `destroy()` interleaving — a notify can
never register after `destroyed` flipped. Making `watch()` async breaks exactly that.
Required contract:

1. Store the line handle **before** awaiting `watch()`.
2. Re-check `destroyed` after `await watch()` and call `unwatch()` if set.
3. The backend serializes `watch`/`unwatch`/`read` per line, so a destroy-triggered
   `unwatch` queued behind an in-flight `watch` always lands after spawn and attach, or
   cancels it.
4. `watch()` delivers no callback before it resolves, and does **not** synthesize an
   initial level on first watch — the adapter has just read it, and a synthesized push
   would double-process. Reconciliation pushes happen on respawns only.
5. `watch()` rejects **only** on terminal classification. Transient spawn failures enter
   the internal ladder and still resolve — otherwise a failed respawn after flap cooldown
   would silently kill the sensor, because `resumeFromFlapping` calls it as
   `void line.watch(...)`.

`unwatch()` may stay async. `startPolledSampling`'s fire-and-forget call is safe because
the first poll fires at +10 s while the kill completes in milliseconds. The real
requirement is per-line operation serialization, so a poll `read()` queues behind the
kill rather than racing a dying monitor into self-`EBUSY`.

### Shutdown

`desiredState: watching | stopped` modelled explicitly in one place, so a deliberate kill
is never misclassified as a crash and respawned. Respawn timers and the attach-poll loop
are per-line state cancelled by `unwatch()`/`close()`. `close()` kills all children and
clears all timers; every timer is `unref`'d so a hung kill cannot block process exit.
`SensorResourcesLifecycleAdapter`'s ordering (registry shutdown, then backend close)
carries over unchanged. A reconcile `gpioget` in flight at destroy is absorbed by the
existing `destroyed` guard.

## Readiness

`DigitalReadinessAdapter` is rewritten. The current `which pigpiod` → `systemctl is-active`
→ TCP connect triplet becomes:

1. `which gpiodetect`
2. `gpiodetect`, matching a known chip label
3. `id -nG` asserting `gpio` group membership, mirroring `rtsp-readiness.adapter.ts`
4. `gpioinfo <chip>` — succeeding proves the running supervisor's effective permissions
5. **`systemctl is-active pigpiod` must fail**

Step 5 is not hygiene. **pigpiod does not use the gpiochip character device** — it mmaps
registers through `/dev/gpiomem`. A surviving pigpiod therefore appears as no line
consumer and produces no `EBUSY`; the entire failure classification above would be blind
to it while it silently fights our bias and glitch settings. Readiness must assert its
absence positively.

Because readiness executes inside the worker process, it correctly stays red until the
supervisor restart lands — the same contract rtsp already has.

## Migration

An OTA cannot carry this change on its own, and that is by design.

`scripts/install-feature.sh` is frozen at install time into the root-owned bundle at
`/usr/lib/home-worker/install-feature-routines` (`install.sh:788`). Changing its
`digital)` case requires bumping `INSTALLER_VERSION` in `scripts/feature-installer.py`
(currently `'1'`). `scripts/update.sh` then refuses the update through
`helper_update_required()` with **exit 3**: *"Run the trusted root installer
(scripts/install.sh) locally to deploy the matching /usr/lib/home-worker helper bundle,
then retry the update."* Shipping the change without the bump would be worse — deployed
boxes would silently keep installing pigpio.

The Telegram feature system cannot substitute. `deriveFeatureStatus`
(`feature-status.ts:64`) maps `readiness-failed` to `action: 'verify'`, which re-runs the
failing probe and loops; `action: 'install'` is reachable only from `installed: false`,
and `BeginFeatureInstallInput.expected` is hard-typed `{ installed: false; enabled: false }`.
Typing `/feature digital install` does not bypass this — command verbs express navigation
intent only, and current state chooses the operation (`feature.handler.ts:79`).

**Therefore the local root `install.sh` run is the migration**, and the helper gate is
what guarantees code and runtime dependencies land together.

Required changes:

- `scripts/install.sh`: replace `install_pigpio` and `setup_pigpiod` with `setup_gpiod` —
  `apt install gpiod`, `usermod -aG gpio "$USER"`, `systemctl disable --now pigpiod` **and
  mask it**. Idempotent; tolerates pigpiod's absence. Masking rather than purging keeps
  rollback free during the verification window.
- `scripts/install-feature.sh`: the `digital)` case installs `gpiod` and adds the `gpio`
  group, and prints the same supervisor-restart warning the rtsp case already prints —
  group changes do not reach the running PM2 daemon.
- `scripts/feature-installer.py`: `INSTALLER_VERSION` `'1'` → `'2'`.
- `config/system-deps.yml`: drop the pigpio comment from `core`; add `digital: apt: [gpiod]`.
- `package.json`: remove `pigpio-client`.
- **Verify the `/system_update` Telegram flow surfaces the exit-3 guidance text** rather
  than a generic failure. That message is the entire migration UX.

### Privilege

The story improves materially. Today `setup_pigpiod` runs a root daemon exposing an
unauthenticated localhost TCP port through which any local process can drive any pin. The
replacement is kernel-enforced group access with no daemon and no port, and it also frees
pigpio's continuous DMA sampling (several percent CPU on a Pi 3; magnitude approximate).
Raspberry Pi OS ships udev rules setting `/dev/gpiochip*` to `root:gpio 0660`.

## Testing

Three tiers, per [testing.md](../../testing.md).

**Injectable spawn seam.** The repo already owns this pattern twice: `spawnCloudflared` in
`quick-tunnel-live-stream.adapter.ts` and `FixedExecFile` in `readiness-seams.ts`. The
backend takes its spawn and exec functions by injection.

**Fixture-pinned CLI contract tests — the regression net that matters.** Capture real
output from both boards: `--version` strings, `gpiodetect`, `gpioinfo`, `gpioget`, and
formatted `gpiomon` event lines, from a Pi 3 (v1.6.3) and a Pi 5 (v2.x). Unit-test the
argument builders and parsers against those fixtures per version. This is the seam Debian
will break on a release bump, and exactly what hand-written mocks cannot catch.

**Adapter tests survive nearly verbatim.** `digital-gpio.adapter.test.ts` already fakes the
gateway structurally, so it carries over as the policy-layer regression net — with the
structural casts replaced by the real interface.

New backend-level cases: orphan sweep identification; `EBUSY` ours vs foreign; respawn
with reconciliation; stale-incarnation event discard; destroy landing mid-`watch`;
`unwatch` then `read` serialization; alarm-line infinite retry.

**On-device smoke, run from the install path:** `gpioget --bias=pull-up` versus
`--bias=pull-down` on a configured-but-unwired pin must read differently. This proves chip
access, bias plumbing and effective permissions with no external hardware. Add a piped-
event latency check — toggle a pin, assert the event arrives in under 100 ms — to validate
the `stdbuf` assumption on real boards.

`gpio-sim` is deliberately **not** on the critical path: it needs root and configfs in CI,
and whether `CONFIG_GPIO_SIM` is enabled in Raspberry Pi kernel builds is unverified.

## Documentation to update

- `docs/ports-and-adapters.md:65` — rewrite the `PigpioGateway` row; the "do not promote to
  port" ruling is overturned deliberately.
- `docs/specs/03-sensor-digital.md` — replace the pigpiod system-setup section; note that
  the hardware glitch filter is v2-only and best-effort.
- `docs/architecture.md` — pigpio references.
- `CLAUDE.md` — the stack table's GPIO row and the sensor-driver convention line.

## Verify on device before implementing

These are explicitly unresolved and must be pinned from real hardware, not documentation:

1. Exact v2 `--format` specifier semantics, and both versions' event line shapes.
2. Whether v1 `gpiomon` flushes per event without `stdbuf` (we pass `stdbuf` regardless).
3. Whether `gpioinfo` consumer polling reliably confirms attach on v1 within the bounded
   window.
4. Actual `gpiodetect` label strings on each board.
5. The registry's `healthCheck` cadence, which bounds the deaf window that fix #1 closes.
6. Whether orphaned children reparent to init or to `systemd --user` under PM2 — informative
   only; identification does not depend on it.

## Out of scope

- UART, MQTT and camera sensor drivers.
- Any change to `stepType` semantics, debounce policy or the circuit breaker.
- PWM, servo or output-mode GPIO; this codebase reads inputs only.
- Replacing the CLI backend with a native binding — a later adapter swap behind the same
  interface, once `node-libgpiod` ships libgpiod 2.x support.
