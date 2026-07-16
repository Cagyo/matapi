# Single Visible Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leave only the newly opened Home visible after every successful open and remove a successful `Open new Home` recovery prompt.

**Architecture:** `OpenHomeUseCase` performs previous-Home cleanup through `HomeMessageDeliveryPort` only after promotion succeeds. `HomeHandler` separately cleans up the interface-owned `ho` recovery message after an `opened` result. Both deletions are best-effort and do not affect Home authority.

**Tech Stack:** TypeScript, NestJS 10, grammY, Vitest

## Global Constraints

- Work directly on `master` without a worktree, per user instruction.
- Preserve reserve → send → promote ordering and durable Home authority.
- Never delete the previous active Home when send or promotion fails.
- Telegram cleanup failures must not mask a successfully opened Home.
- Do not modify unrelated working-tree changes.

---

### Task 0: Preserve reservation identity through SQLite timestamp storage

**Files:**
- Modify: `test/telegram/infrastructure/drizzle-home-session.store.test.ts`
- Modify: `src/telegram/infrastructure/drizzle-home-session.store.ts`

**Interfaces:**
- Consumes: Drizzle SQLite `timestamp` values stored as Unix seconds
- Produces: reservation expiry comparison at one-second storage precision

- [x] **Step 1: Write the failing real-SQLite regression test**

Reserve with a JavaScript `Date` containing nonzero milliseconds and assert
that the exact reservation can still be promoted after the expiry round-trip.

- [x] **Step 2: Run the test to verify RED**

Run: `yarn test test/telegram/infrastructure/drizzle-home-session.store.test.ts`

Observed: FAIL with `{ kind: 'lost' }` instead of `promoted`.

- [x] **Step 3: Compare expiry at SQLite timestamp precision**

Compare `Math.floor(date.getTime() / 1_000)` for both reservation expiry values
while retaining exact comparison for every other reservation field.

- [x] **Step 4: Run the test to verify GREEN**

Run: `yarn test test/telegram/infrastructure/drizzle-home-session.store.test.ts`

Observed: 20 tests passed.

### Task 1: Delete the previous authoritative Home after replacement

**Files:**
- Modify: `test/telegram/application/open-home.use-case.test.ts`
- Modify: `test/telegram/infrastructure/telegram-home-message.adapter.test.ts`
- Modify: `src/telegram/application/ports/home-message-delivery.port.ts`
- Modify: `src/telegram/application/open-home.use-case.ts`
- Modify: `src/telegram/infrastructure/in-memory-home-message-delivery.adapter.ts`
- Modify: `src/telegram/infrastructure/telegram-home-message.adapter.ts`
- Modify: `docs/ports-and-adapters.md`

**Interfaces:**
- Consumes: `HomeSessionStorePort.promoteNew(...)`
- Produces: `HomeMessageDeliveryPort.deleteMessage(chatId: number, messageId: number): Promise<void>`

- [x] **Step 1: Write failing use-case and adapter tests**

Add assertions that a successful replacement records `deleteMessage` after
`promote`, that delete failure still returns `opened`, and that the Telegram
adapter calls `bot.api.deleteMessage(chatId, messageId)`.

- [x] **Step 2: Run tests to verify RED**

Run: `yarn test test/telegram/application/open-home.use-case.test.ts test/telegram/infrastructure/telegram-home-message.adapter.test.ts`

Observed: FAIL because `deleteMessage` was not part of the port/adapters and the
old Home is still handled with `stripKeyboard`.

- [x] **Step 3: Implement minimal port and adapter behavior**

Add:

```ts
deleteMessage(chatId: number, messageId: number): Promise<void>;
```

After `promoteNew` returns `promoted`, invoke the method for
`promotion.previous` inside a best-effort helper. Keep `stripKeyboard` for the
newly sent message when promotion returns `lost`.

- [x] **Step 4: Run focused tests to verify GREEN**

Run: `yarn test test/telegram/application/open-home.use-case.test.ts test/telegram/infrastructure/telegram-home-message.adapter.test.ts`

Observed: both files passed (14 tests).

### Task 2: Remove a successful Open-new-Home recovery prompt

**Files:**
- Modify: `test/telegram/interfaces/home.handler.test.ts`
- Modify: `src/telegram/interfaces/home.handler.ts`

**Interfaces:**
- Consumes: `OpenHomeUseCase.execute(input): Promise<OpenHomeResult>`
- Produces: best-effort deletion of `ctx.callbackQuery.message.message_id` for `ho` only after `opened`

- [x] **Step 1: Write failing handler tests**

Add tests proving `ho` calls `ctx.api.deleteMessage(chatId, sourceMessageId)`
after `opened`, ignores deletion rejection, and retains the source for
`superseded` or unavailable results.

- [x] **Step 2: Run handler test to verify RED**

Run: `yarn test test/telegram/interfaces/home.handler.test.ts`

Observed: FAIL because `HomeHandler` did not delete the recovery source.

- [x] **Step 3: Implement minimal callback-source cleanup**

Make `open` return the `OpenHomeResult` outcome needed by `handleCallback`.
For `OPEN_NEW_HOME_CALLBACK`, delete the callback source only when the result is
`opened`; catch and ignore Telegram deletion errors.

- [x] **Step 4: Run handler test to verify GREEN**

Run: `yarn test test/telegram/interfaces/home.handler.test.ts`

Observed: file passed (15 tests).

### Task 3: Verify and commit the complete behavior

**Files:**
- Verify all files changed in Tasks 1–2 plus this plan and the approved design.

**Interfaces:**
- Consumes: completed Tasks 1–2
- Produces: a tested single-visible-Home lifecycle on `master`

- [x] **Step 1: Run focused regression tests**

Run: `yarn test test/telegram/application/open-home.use-case.test.ts test/telegram/infrastructure/telegram-home-message.adapter.test.ts test/telegram/interfaces/home.handler.test.ts test/telegram/interfaces/home-launcher.test.ts test/telegram/interfaces/return-home.handler.test.ts`

Observed: the expanded focused set passed (75 tests).

- [x] **Step 2: Run the full test suite**

Run: `yarn test`

Observed: 527 suites and 1,835 tests passed; zero failures.

- [x] **Step 3: Run the production build**

Run: `yarn build`

Observed: exit code 0.

- [x] **Step 4: Review the scoped diff and commit**

Staged only the files named in this plan and committed with:

```text
fix(telegram): keep newly opened Home active
```
