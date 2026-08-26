# Testing

> **Dependencies:** [architecture.md](architecture.md), [ports-and-adapters.md](ports-and-adapters.md).

Three test tiers. Each tier maps to one architectural layer. **A test that mixes tiers is the bug.**

```
unit         → domain/        no mocks, no async setup, no I/O
use-case     → application/   in-memory adapters, no Nest container
integration  → infrastructure/ real tech (real SQLite tmp file, real serialport mock harness, real grammY in test mode)
```

Vitest is the only test runner. Test files live under `test/`, mirroring `src/` paths.

## Tier 1 — Unit (domain)

Pure functions and value-object invariants. Constructed in one line. No mocks.

```ts
// test/sensors/domain/quiet-hours.test.ts
import { describe, it, expect } from 'vitest';
import { QuietHours } from '../../../src/sensors/domain/quiet-hours';

describe('QuietHours', () => {
  it('rejects malformed start/end strings', () => {
    expect(() => new QuietHours('25:00', '08:00')).toThrow(/invalid time/);
  });

  it('includes the start minute and excludes the end minute', () => {
    const q = new QuietHours('22:00', '07:00');
    expect(q.contains('22:00')).toBe(true);
    expect(q.contains('07:00')).toBe(false);
  });
});
```

- Zero `vi.fn()` calls.
- One assertion per behavior, multiple `it` blocks; not one mega-test.
- If a domain test needs a mock, the dependency belongs behind a port — push it to the use-case tier.

## Tier 2 — Use case (application)

The use case constructed manually with **in-memory adapters**. No Nest `Test.createTestingModule()`. The point is to exercise business orchestration.

```ts
// test/events/application/drain-event-queue.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DrainEventQueueUseCase } from '../../../src/events/application/drain-event-queue.use-case';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

describe('DrainEventQueueUseCase', () => {
  it('marks sent events with the notifier timestamp', async () => {
    const repo = new InMemoryEventRepository();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const clock = { now: () => new Date('2030-01-01T00:00:00Z') };
    const useCase = new DrainEventQueueUseCase(repo, notifier, clock);

    await repo.insert({ sensorId: 's1', type: 'state_change', newValue: true, timestamp: new Date() });
    await useCase.execute();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(await repo.pending()).toHaveLength(0);
  });
});
```

- **In-memory adapter** (`InMemoryEventRepository`) ships with the production code under `infrastructure/`. It is not a test fixture — it's a real implementation of the port that happens to use a `Map`.
- `vi.fn()` is reserved for *outbound* ports invoked once or twice (notifier, clock when not worth a class). For stateful or repeated calls, write a small in-memory adapter.
- The current [`test/sensors/digital.driver.test.ts`](../test/sensors/digital.driver.test.ts) is a **tier-3** test (it exercises the GPIO adapter against a mock gateway). Keep it; new application logic goes through tier 2.

## Tier 3 — Integration (infrastructure)

One adapter against the real underlying tech, isolated:

| Tech | Real test target | Isolation |
|---|---|---|
| Drizzle / SQLite | `better-sqlite3` against a `:memory:` or `tmp/` file | Per-test fresh DB; run `migrate()` in `beforeEach` |
| pigpio | `PigpioGateway` is the seam — mock the gateway, real driver above it (see [`digital.driver.test.ts`](../test/sensors/digital.driver.test.ts)) | Already in place |
| serialport (UART) | `@serialport/binding-mock` virtual port | Per-test port |
| grammY | grammY's own test transport | One bot instance per test |
| Motion / systemctl | **Do not** integration-test daemon control from CI. Cover with adapter unit tests that mock the `child_process` boundary, then validate on-device manually. |
| Google Drive | Use fake HTTP/SDK gateways in CI; run the disposable-account procedure in `test/archive/google-drive-live-smoke.md` before release. |

```ts
// test/events/infrastructure/drizzle-event.repository.test.ts
beforeEach(() => {
  sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: './migrations' });
  repo = new DrizzleEventRepository(drizzle(sqlite));
});
```

## Patterns for adapters that must not write

Established by the RTSP camera-source lifecycle; reuse them, and prefer them to
the mock-shaped alternative each one replaces.

**Force a failure with real SQLite, not a production seam.** To prove a
multi-table write is atomic, install a trigger in the test and let the real
transaction fail:

```sql
CREATE TRIGGER reject_credentials BEFORE INSERT ON camera_live_credentials
BEGIN SELECT RAISE(ABORT, 'injected credential failure'); END;
```

The alternative — an injectable "fail here" hook in the adapter — proves only
that the hook works, and leaves a production seam behind whose only caller is a
test. See [drizzle-rtsp-source-configuration.adapter.test.ts](../test/camera/infrastructure/drizzle-rtsp-source-configuration.adapter.test.ts)
and [drizzle-home-session.store.test.ts](../test/telegram/infrastructure/drizzle-home-session.store.test.ts).

**Assert "nothing was written" against real state, not mock call counts.**
Serialize the credential-free store — cameras plus sources — before the
attempted mutation and compare after:

```ts
const before = snapshot(subject);
await expect(subject.replace.execute(input)).rejects.toThrow(LiveSourceStateChangedError);
expect(snapshot(subject)).toBe(before);
```

`expect(repo.save).not.toHaveBeenCalled()` proves only that one method was not
called; the snapshot catches every write, including one through a path the test
did not think of.

**Run a contract table across every adapter that implements the port.** A port
with a real adapter and an in-memory twin is only useful while the two answer
identically, so one `describe.each` table drives both — and both through their
real entry points, never a reimplementation of the rule under test. Two live
examples: [rtsp-source-configuration.contract.test.ts](../test/camera/infrastructure/rtsp-source-configuration.contract.test.ts)
(Drizzle vs. two in-memory wirings) and
[rtsp-policy-containment.contract.test.ts](../test/camera/infrastructure/rtsp-policy-containment.contract.test.ts)
(the probe's enforcement CIDR arithmetic vs. the status evaluator's).

> **A contract table that only asserts agreement is satisfied by two
> implementations that agree on being broken.** If both regress to always-deny,
> every per-row agreement assertion still passes. So a table over independent
> implementations must also assert non-vacuity: a floor on the rows both sides
> *admit* and on the rows both sides *refuse*. Deliberate divergences are listed
> as rows of their own and the divergence set is pinned exactly, so a third one
> fails the suite the moment it appears.

**Guard fixture coverage by walking the table.** Where behavior is driven by an
exported table — the probe's ordered diagnostic markers — a test iterates the
table itself and fails on a row with no fixture, and on a fixture that only
reaches its row because an earlier row shadows it. A hand-written list of cases
silently stops covering the table the day someone appends to it. See
[live-source-probe-diagnostics.test.ts](../test/camera/infrastructure/live-source-probe-diagnostics.test.ts).

**Prove the test bites before you keep it.** After writing a test for a fix,
revert the fix (or mutate the one line it depends on) and confirm the test fails
for the reason you expect. A regression test that passes against the bug is
worse than none: it certifies the bug.

## Composition tests and the decorator-metadata blind spot

This applies to the whole repo, not to one module. **Under Vitest, a bare-class
constructor dependency resolves to `undefined`, silently.**

`tsconfig.json` sets `emitDecoratorMetadata`, so `nest build` emits
`design:paramtypes` and production Nest can resolve a parameter from its type
alone. The test build is esbuild, which emits no such metadata at all. Nest then
resolves *only* parameters carrying an explicit `@Inject(...)` token, and every
other constructor parameter is injected as `undefined` without an error.

The trap is that this makes the obvious composition test nearly meaningless. A
test that boots `AppModule`, resolves a class and asserts it exists will pass
with half that class's collaborators missing — the same graph that would have
failed loudly in production. So:

- **Pin against an explicit token.** Assert that the instance the container
  hands the port *is the same object* the consumer holds — `toBe`, not
  `toBeInstanceOf`, which is what a `useExisting` → `useClass` slip changes and
  an `instanceof` check cannot see.
- **Do not conclude that a bare-class dependency is wired** because the
  container produced an object. It proves nothing under this build.
- **Carry a bidirectional tripwire.** The blind spot is a property of the
  toolchain, not a permanent law, so the test that relies on it should also fail
  when it stops being true. `test/telegram/telegram.module.composition.test.ts`
  asserts both directions: `design:paramtypes` is `undefined`, the bare-class
  dependencies are `undefined`, and the tokened ones are defined. If a future
  build starts emitting metadata, that test fails — which is the notice that the
  token-only pins can and should be widened to the whole constructor.

## Test file location & naming

```
test/
  <context>/
    domain/      *.test.ts        # tier 1
    application/ *.test.ts        # tier 2
    infrastructure/ *.test.ts     # tier 3
```

- File name matches the SUT: `digital-gpio.adapter.test.ts` for `digital-gpio.adapter.ts`.
- One SUT per test file.
- No `describe.skip` / `it.only` committed.

## What to test, what not to

| Always | Never |
|---|---|
| Domain invariants (every public method of a value object) | Getters/setters with no logic |
| Every branch in a use case | Nest's DI container itself |
| Every error mapping in an adapter (the `catch` arm) | Drizzle's query builder |
| Every command handler's error→reply mapping (one test per `if (err instanceof ...)`) | grammY's middleware chain |
| Debounce / threshold / quiet-hours edge cases | The fact that `pino` logs something |

## Determinism rules

- **No real time.** Inject `ClockPort` or pass a fixed `Date` into the SUT. Use `vi.useFakeTimers()` only when testing timer-driven code (debounce); restore in `afterEach`.
- **No real randomness.** Pass a seeded RNG or a fixed value where it matters (invite-code generation).
- **No network calls.** Period. Integration tests use loopback / in-memory.
- **No real filesystem outside `test/.tmp/`.** Use `tmpdir()` and clean up.


### Fake timers over real I/O

Tests that drive real filesystem or Unix-socket work *underneath*
`vi.useFakeTimers()` need three things, and the first is not optional.

**Restore the clock in `afterEach`, unconditionally — not only in a `finally`.**
A test that exceeds its timeout is abandoned *inside its body*, so a `finally`
at the end of the test never runs and the fake clock leaks into the next test,
which fails with "Timers are not mocked". One slow run then surfaces as two
failures, and the second one names innocent code. An unconditional
`afterEach(() => vi.useRealTimers())` makes a timeout cost exactly one test.

**Wait on a condition, never on a fixed number of microtask hops.** A hop count
is a guess about how long an async chain is, and it is only ever right on an
idle machine; under load the chain interleaves with other work and the test
races for reasons that have nothing to do with the code under test. Wait for the
state you actually mean, with a high bound so a genuine hang still fails:

```ts
async function until(condition: () => boolean, hops = 100): Promise<void> {
  for (let hop = 0; hop < hops; hop += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition(), 'the adapter never reached the awaited state').toBe(true);
}
```

**Give the file a timeout that reflects a loaded machine**, with
`vi.setConfig({ testTimeout: … })` at the top of the file rather than a global
bump. The wall-clock cost of these cases is set by how loaded the box is, not by
anything they assert, and the default is comfortable when run alone and marginal
inside a full-suite run — where the failure arrives as a timeout,
indistinguishable in CI from a real hang in the adapter. See
[quick-tunnel-rtsp-live-stream.adapter.test.ts](../test/camera/infrastructure/quick-tunnel-rtsp-live-stream.adapter.test.ts).

## Coverage target

No enforced number. The implicit target is **every public method of every use case** and **every domain-error arm of every interface handler**. Drizzle calls inside an adapter are covered by one integration test of the happy path plus one per translated error; that is enough.

## Commands

```bash
yarn test            # vitest run, all tiers
yarn test --watch    # local development
yarn test path/to/file.test.ts   # single file
```

## What the delivery gate proves — and what it does not

The three commands above are the gate, and each one covers a different, partial
slice of the tree. Read a green gate as exactly this much:

| Command | Covers | Does **not** cover |
|---|---|---|
| `yarn test` | every tier, `test/**` and `src/**/*.test.ts` | anything a test does not assert; TS diagnostics (Vitest transpiles, it does not typecheck) |
| `yarn build` | `nest build` over `src/**` — `tsconfig.json` sets `"include": ["src/**/*"]` | **`test/**` — no test file is typechecked by `tsc`, and never has been** |
| `yarn lint` | `src`, `test` and `scripts`, with `recommendedTypeChecked` rules against `tsconfig.eslint.json`, which *does* include `test/**` | full assignability checking; a type error in a test that no lint rule happens to flag stays invisible |

So **"typecheck passes" is not an unqualified claim for `test/**`.** Test files
get type-*aware lint* rules, which catch a real and useful subset — unsafe
arguments, floating promises, misused promises — but they do not get TS
diagnostics. A whole-program `npx tsc --noEmit` over `test/**` is not a
maintained gate here: it currently reports a large backlog of pre-existing
errors in test files unrelated to any one change, so running it ad hoc tells you
almost nothing about the change in front of you. If you want a test file
typechecked, the honest options are to keep its types simple enough that the
lint rules bite, or to fix the backlog first — not to imply the gate already
did it.
