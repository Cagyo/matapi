# Bot Polling Restart Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a stale Telegram update timestamp from causing grammY to restart every 30 seconds indefinitely.

**Architecture:** Keep restart ownership in `GrammyBotGateway`. Start the replacement runner first, then clear `lastUpdateAt` only after that start succeeds so the watchdog treats the replacement as fresh without suppressing retries after a failed restart.

**Tech Stack:** TypeScript, NestJS 10, grammY runner, Vitest.

## Global Constraints

- Preserve the existing two-minute stale-update threshold and 30-second watchdog interval.
- Preserve Home callback acknowledgement, handler ordering, and the `ho` callback contract.
- Do not add dependencies or change ports.
- Keep failures retryable: a replacement-runner start failure must retain the stale timestamp.

---

### Task 1: Reset polling freshness after successful runner replacement

**Files:**
- Modify: `test/telegram/infrastructure/grammy-bot.gateway.test.ts`
- Modify: `src/telegram/infrastructure/grammy-bot.gateway.ts:204-209`
- Modify: `docs/superpowers/specs/2026-07-16-bot-polling-restart-loop-design.md`

**Interfaces:**
- Consumes: `GrammyBotGateway.restart(): Promise<void>` and `getLastUpdateAt(): Date | null`.
- Produces: A successful restart resets `getLastUpdateAt()` to `null`; a failed replacement start retains the stale timestamp.

- [x] **Step 1: Expose the mocked runner factory and write failing regression tests**

Change the hoisted runner mock to expose `run`, then add these cases:

```typescript
const run = vi.fn(() => ({ isRunning: () => true }));

vi.mock('@grammyjs/runner', () => ({
  run: mocks.run,
  sequentialize: mocks.sequentialize,
}));

it('clears stale update freshness after a successful runner restart', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const gateway = Object.create(GrammyBotGateway.prototype);
  Object.assign(gateway, {
    bot: {},
    runner: { isRunning: () => true, stop },
    lastUpdateAt: new Date('2030-01-01T00:00:00.000Z'),
    logger: { warn: vi.fn() },
  });

  await gateway.restart();

  expect(stop).toHaveBeenCalledTimes(1);
  expect(gateway.getLastUpdateAt()).toBeNull();
});

it('retains stale update freshness when replacement runner startup fails', async () => {
  const stale = new Date('2030-01-01T00:00:00.000Z');
  const gateway = Object.create(GrammyBotGateway.prototype);
  Object.assign(gateway, {
    bot: {},
    runner: { isRunning: () => false },
    lastUpdateAt: stale,
    logger: { warn: vi.fn() },
  });
  mocks.run.mockImplementationOnce(() => { throw new Error('runner failed'); });

  await expect(gateway.restart()).rejects.toThrow('runner failed');

  expect(gateway.getLastUpdateAt()).toBe(stale);
});
```

- [x] **Step 2: Run the regression tests to verify RED**

Run:

```bash
yarn test test/telegram/infrastructure/grammy-bot.gateway.test.ts
```

Expected: the successful-restart case fails because `getLastUpdateAt()` still returns the stale `Date`.

- [x] **Step 3: Implement the minimal lifecycle fix**

Update `restart()` so freshness is reset only after `run` returns successfully:

```typescript
async restart(): Promise<void> {
  if (!this.bot) return;
  if (this.runner?.isRunning()) await this.runner.stop();
  const replacement = run(this.bot);
  this.runner = replacement;
  this.lastUpdateAt = null;
  this.logger.warn('grammY runner force-restarted');
}
```

Update the design note to say the replacement runner starts before the timestamp is cleared, documenting that a failed `run` remains retryable.

- [x] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
yarn test test/telegram/infrastructure/grammy-bot.gateway.test.ts test/network/application/check-bot-polling.service.test.ts test/telegram/interfaces/home.handler.test.ts test/telegram/interfaces/home-callback-ack.middleware.test.ts
```

Expected: all focused tests pass with zero failures.

- [x] **Step 5: Verify the production build**

Run:

```bash
yarn build
```

Expected: Nest TypeScript compilation exits successfully.

- [x] **Step 6: Commit the implementation**

```bash
git add test/telegram/infrastructure/grammy-bot.gateway.test.ts src/telegram/infrastructure/grammy-bot.gateway.ts docs/superpowers/specs/2026-07-16-bot-polling-restart-loop-design.md docs/superpowers/plans/2026-07-16-bot-polling-restart-loop.md
git commit -m "fix(telegram): stop polling restart loop"
```
