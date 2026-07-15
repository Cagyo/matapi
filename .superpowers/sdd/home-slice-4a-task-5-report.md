# Home Slice 4a — Task 5 Report

## Scope

Added Return Home navigation to CSV export and personal settings, including the approved live-staging status.

Changed files:

- `src/telegram/interfaces/csv.handler.ts`
- `src/telegram/interfaces/settings.handler.ts`
- `src/locales/en.ts`
- `src/locales/ru.ts`
- `src/locales/uk.ts`
- `test/telegram/interfaces/csv.handler.test.ts`
- `test/telegram/interfaces/settings.handler.test.ts`
- `test/locales/catalog.test.ts`

## TDD evidence

### RED

Before implementation, ran:

```bash
yarn test test/telegram/interfaces/csv.handler.test.ts test/telegram/interfaces/settings.handler.test.ts test/locales/catalog.test.ts
```

Result: 18 expected failures across 33 tests.

The failures established that:

- `csv.staging` was missing in every catalog;
- picker, terminal, document, and settings messages lacked their `rh` callbacks;
- the deferred-stage regression observed `returnedBeforeStageRelease === false`, proving the current callback still held gateway sequentialization while staging;
- error/empty picker variants removed or omitted Return Home markup.

### GREEN

Implemented the smallest lifecycle boundary needed to satisfy the tests:

- CSV now uses `TelegramContext` throughout and reads the active catalog without casts.
- A verified picker selection removes old markup best-effort, sends localized `csv.staging` with `rh:c:r`, and starts staging in a detached, rejection-catching task.
- The picker lock remains until that detached task settles; the pending duplicate selection gets the existing `csv.inProgress` response and cannot clear the first lock.
- Named `/csv <sensor> [count]` sends the same leave-running message and returns before deferred staging resolves.
- Documents and terminal/error/empty replies use `rh:c:t`; new and re-rendered pickers use `rh:c:c`.
- Settings has exactly the three language actions plus a fourth `rh:s:c` Home row, regenerated from the current catalog after a locale change.

Focused verification after implementation:

```bash
yarn test test/telegram/interfaces/csv.handler.test.ts test/telegram/interfaces/settings.handler.test.ts test/locales/catalog.test.ts
```

Result: 3 files passed, 33 tests passed.

## Full verification

```bash
yarn build
# exit 0

yarn test --silent
# elevated; exit 0
```

The definitive elevated full-suite log reports:

```text
Test Files  242 passed (242)
     Tests  1678 passed (1678)
```

The full suite emits expected Nest fixture logs despite `--silent`; they do not represent test failures. Its captured log is outside the repository at `/private/tmp/home-slice-4a-task-5-full-test.log`.

## Self-review

- Confirmed `ReturnHomeHandler` only launches Home for `rh:c:r`; it has no cancellation behavior, so staging continues after Home opens.
- Retained selector verification, page validation, callback byte limit, mapped stage errors, temporary-file disposal, and pagination behavior.
- The detached runner catches and logs unexpected rejections, while its `finally` releases only the originating picker lock.
- No message-ID cleanup state or cancellation state was added.
- Staging text in English, Russian, and Ukrainian contains no sensor name or Markdown and explicitly says Home may be opened without cancelling the export.
- `git diff --check` passed. Unrelated pre-existing scratch reports, plans, and cache files were left untouched.

## Concerns

None for this task. The existing suite's verbose fixture logs are expected test diagnostics only.
