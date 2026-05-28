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
| rclone, motion, systemctl | **Do not** integration-test these from CI. Cover with adapter unit tests that mock the `child_process` boundary, then validate on-device manually. |

```ts
// test/events/infrastructure/drizzle-event.repository.test.ts
beforeEach(() => {
  sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: './migrations' });
  repo = new DrizzleEventRepository(drizzle(sqlite));
});
```

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

## Coverage target

No enforced number. The implicit target is **every public method of every use case** and **every domain-error arm of every interface handler**. Drizzle calls inside an adapter are covered by one integration test of the happy path plus one per translated error; that is enough.

## Commands

```bash
yarn test            # vitest run, all tiers
yarn test --watch    # local development
yarn test path/to/file.test.ts   # single file
```
