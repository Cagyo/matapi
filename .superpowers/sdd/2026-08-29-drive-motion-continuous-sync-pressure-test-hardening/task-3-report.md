# Task 3 report — safe initial folder resolution after database rollback

## Status

`DONE`

## What changed

- Replaced the resolver's parent-only discovery decision with one shared bounded
  traversal used parent-first and identity-second.
- Made incomplete search, page-bound exhaustion, and a second rejected page
  token throw `DriveFolderDiscoveryUncertainError` before any current head is
  written.
- Adopted a single surviving live identity through the existing current-slot
  CAS before exact metadata classification. Renamed, moved, shared, or otherwise
  invalid identities become detached; multiple live identities become conflict.
- Added `appendMissingIdentity`, which stores trashed identities as immutable
  `missing` history with `currentSlot = null`, idempotently by global Drive
  folder ID, without changing a current path head.
- Delayed generated-ID reservation and creation until both discovery scopes
  prove that no live identity remains.
- Scheduled every newly blocked resolver head at the first 15-minute slot with
  fresh bounded jitter. The injected random source keeps tests deterministic;
  the first deadline is `now + 15m + [0, 999]ms`.

## Files changed

- `src/archive/application/use-cases/resolve-motion-archive-container.use-case.ts`
- `src/archive/application/ports/drive-folder-reservation-repository.port.ts`
- `src/archive/infrastructure/persistence/drizzle-drive-folder-reservation.repository.ts`
- `src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository.ts`
- `test/archive/application/resolve-motion-archive-container.use-case.test.ts`

## TDD evidence

### RED — rollback and uncertainty behavior

Command:

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts
```

Output (exit 1):

```text
Test Files  1 failed (1)
Tests  10 failed | 21 passed (31)
```

The failures were the intended missing behaviors:

- only three parent-scope calls were made instead of the required six
  parent/identity calls;
- a second rejected token remained `DRIVE_FOLDER_PAGE_TOKEN_REJECTED` instead
  of discovery uncertainty;
- renamed, moved, and shared rollback identities fell through to generated-ID
  creation;
- trashed identities produced no missing history; and
- incomplete, page-bound, and second-token identity uncertainty attempted
  generated-ID creation instead of leaving the day head absent.

### GREEN — requested resolver behavior

Command:

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts
```

Output (exit 0 after the initial implementation):

```text
Test Files  1 passed (1)
Tests  31 passed (31)
```

### Mutation RED — duplicate live identity and idempotent missing history

Two explicit regression cases were then added. I temporarily removed the live
duplicate conflict branch and the in-memory folder-ID idempotency guard.

Command:

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts
```

Output (exit 1):

```text
FAIL blocks several live rollback identities as conflict without creating a folder
  promise resolved "conflict-marker-id" instead of rejecting
FAIL does not duplicate missing history when a trashed identity is rediscovered
  expected length 1, received 2
Test Files  1 failed (1)
Tests  2 failed | 31 passed (33)
```

After restoring the two required branches, the same command exited 0 with
33/33 tests passing.

## Final verification

Exact regression command:

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts test/archive/application/archive-provider-gate.service.test.ts test/archive/infrastructure/in-memory-drive-folder-reservation.repository.test.ts test/archive/infrastructure/drizzle-drive-folder-reservation.repository.test.ts
```

Output (exit 0):

```text
Test Files  4 passed (4)
Tests  73 passed (73)
```

Additional commands, all exit 0:

```sh
yarn build
yarn eslint src/archive/application/use-cases/resolve-motion-archive-container.use-case.ts src/archive/application/ports/drive-folder-reservation-repository.port.ts src/archive/infrastructure/persistence/drizzle-drive-folder-reservation.repository.ts src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository.ts test/archive/application/resolve-motion-archive-container.use-case.test.ts
git -c core.fsmonitor=false diff --check
```

## Decisions

- Candidate classification waits for a complete bounded traversal. Even if an
  early page already suggests conflict, later discovery uncertainty wins and
  no durable conflict is written from incomplete evidence.
- Trashed identities are appended only after the identity traversal completes,
  so partial pages cannot leave partial rollback classification behind.
- A live identity is placed in the current slot before exact validation. This
  makes a user-modified surviving ID, rather than a generated marker or parallel
  folder, the durable detached authority.
- Missing-history idempotency checks the globally unique folder ID inside the
  Drizzle immediate transaction. It neither occupies nor releases the current
  path slot. The in-memory adapter mirrors this behavior.
- The initial revalidation jitter uses the same bounded sub-second style as the
  existing provider retry policy. Task 4 can extend the later slot sequence
  without changing Task 3's persisted first-deadline contract.

## Concurrency and provider-bound self-review

- The installation-wide remote mutation lock still serializes folder
  resolution, while every adoption, generated reservation, and conflict marker
  uses the existing null-head CAS. A CAS loser reloads and validates the winner;
  it never creates its losing ID.
- Appending trashed history is independent of the current path slot. If a later
  head CAS loses, the history remains valid and the winner is resolved normally.
- The Drizzle history append runs in an immediate transaction, checks global
  folder-ID existence, then inserts one non-current row. Concurrent writers
  cannot create two rows for the same folder ID.
- Each discovery scope traverses at most `maxPages`, may restart from page one
  once, and then throws uncertainty. Thus one scope performs at most
  `2 * maxPages` list operations, and identity discovery runs only after a
  complete parent traversal found no exact candidate.
- Candidate maps deduplicate provider pages by exact Drive ID. No name-only
  query or user-folder mutation was added.
- Discovery uncertainty is the Task 2 temporary-unavailable subtype, so the
  existing provider-gate regression confirms it remains compatible with the
  generation-scoped folder-operation cooldown behavior.

## Concerns

- Vitest emits the repository's pre-existing Vite CJS deprecation warning. It
  does not affect the 73 passing tests.

## Fix Round 1

### Scope

- Added multi-page identity-discovery pressure cases where page one contains
  partial trashed, live, or duplicate-live conflict evidence before a later
  incomplete page, page-bound exhaustion, or second rejected page token.
- Each uncertainty case asserts that history, the day current head, generated
  IDs, and admin alerts remain untouched.
- Added direct in-memory and Drizzle adapter tests for global folder-ID
  idempotency, null-slot isolation with an unrelated current head, and two
  concurrent appends returning one `stored` and one `exists`.
- No production files were changed; no Task 4 revalidation operation was
  introduced.

### Mutation proof

The new tests were checked against temporary mutations and every mutation was
restored immediately:

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts -t 'partial trashed evidence before incomplete search'
```

Output: exit 1; `1 failed | 35 skipped`, receiving `fake generated ID queue
exhausted` instead of `DRIVE_FOLDER_DISCOVERY_UNCERTAIN`.

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts -t 'partial live evidence before the page bound'
```

Output: exit 1; `1 failed | 35 skipped`, receiving `fake generated ID queue
exhausted` instead of `DRIVE_FOLDER_DISCOVERY_UNCERTAIN`.

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts -t 'partial conflict evidence before a second token rejection'
```

Output: exit 1; `1 failed | 35 skipped`, receiving
`DRIVE_FOLDER_PAGE_TOKEN_REJECTED` instead of
`DRIVE_FOLDER_DISCOVERY_UNCERTAIN`.

```sh
yarn test test/archive/infrastructure/in-memory-drive-folder-reservation.repository.test.ts -t 'idempotent by the globally unique folder ID|returns one stored and one exists'
```

Output: exit 1; `2 failed | 6 skipped`, with duplicate appends returning
`stored`/`stored`.

```sh
yarn test test/archive/infrastructure/drizzle-drive-folder-reservation.repository.test.ts -t 'idempotent by the globally unique folder ID'
```

Output: exit 1; `1 failed | 9 skipped`, with the first append returning
`exists` instead of `stored`.

```sh
yarn test test/archive/infrastructure/in-memory-drive-folder-reservation.repository.test.ts -t 'keeps missing history outside the current slot'
```

Output: exit 1; `1 failed | 7 skipped`, with the missing row carrying
`currentSlot: 1` instead of `null`.

```sh
yarn test test/archive/infrastructure/drizzle-drive-folder-reservation.repository.test.ts -t 'keeps missing history outside the current slot'
```

Output: exit 1; `1 failed | 9 skipped`, with the incorrectly current missing
row returned by `loadCurrent`.

All production mutations were then restored.

### Final verification

Exact Task 3 regression command:

```sh
yarn test test/archive/application/resolve-motion-archive-container.use-case.test.ts test/archive/application/archive-provider-gate.service.test.ts test/archive/infrastructure/in-memory-drive-folder-reservation.repository.test.ts test/archive/infrastructure/drizzle-drive-folder-reservation.repository.test.ts
```

Output (exit 0):

```text
Test Files  4 passed (4)
Tests  82 passed (82)
```

Additional commands (all exit 0):

```sh
yarn eslint test/archive/application/resolve-motion-archive-container.use-case.test.ts test/archive/infrastructure/in-memory-drive-folder-reservation.repository.test.ts test/archive/infrastructure/drizzle-drive-folder-reservation.repository.test.ts
yarn build
git -c core.fsmonitor=false diff --check
```

### Files changed

- `test/archive/application/resolve-motion-archive-container.use-case.test.ts`
- `test/archive/infrastructure/in-memory-drive-folder-reservation.repository.test.ts`
- `test/archive/infrastructure/drizzle-drive-folder-reservation.repository.test.ts`
- `.superpowers/sdd/2026-08-29-drive-motion-continuous-sync-pressure-test-hardening/task-3-report.md`

### Concerns

- The existing Vitest Vite CJS deprecation warning remains; it does not affect
  the 82 passing regression tests.
