# Task 2 Report: MediaRepositoryPort.listAllMediaPaths

## What I implemented
- Added `listAllMediaPaths(): Promise<string[]>` to `MediaRepositoryPort`.
- Implemented `listAllMediaPaths()` in `InMemoryMediaRepository` by returning every non-null `videoPath` and `snapshotPath` from seeded events.
- Implemented `listAllMediaPaths()` in `DrizzleMediaRepository` by selecting `videoPath` and `snapshotPath` from `motionEvents` and flattening non-null values.
- Added a focused regression test for `InMemoryMediaRepository.listAllMediaPaths`.

## Tests run and results
- `yarn test test/camera/infrastructure/in-memory-media.repository.test.ts`
  - First run: failed with `repo.listAllMediaPaths is not a function` as expected.
  - Second run after implementation: passed.
- `yarn build`
  - Passed.

## TDD Evidence
### RED command/output summary
- Command: `yarn test test/camera/infrastructure/in-memory-media.repository.test.ts`
- Result: failed because `listAllMediaPaths` was missing on `InMemoryMediaRepository`.

### GREEN command/output summary
- Command: `yarn test test/camera/infrastructure/in-memory-media.repository.test.ts`
- Result: passed after adding the new method to the port and both repository adapters.
- Command: `yarn build`
- Result: passed.

## Files changed
- `src/camera/domain/ports/media-repository.port.ts`
- `src/camera/infrastructure/drizzle-media.repository.ts`
- `src/camera/infrastructure/in-memory-media.repository.ts`
- `test/camera/infrastructure/in-memory-media.repository.test.ts`

## Self-review findings
- The new API is intentionally narrow and matches the task brief exactly.
- The in-memory implementation preserves the "all referenced paths, regardless of flags" behavior needed for orphan-sweep logic.
- The Drizzle implementation mirrors the same contract without introducing any new filtering.

## Issues/concerns
- None in the touched scope.

## Fix follow-up
- Updated `test/camera/infrastructure/in-memory-media.repository.test.ts` so the seed data now includes events with mixed `uploadedToGdrive` and `localDeleted` values while still asserting every non-null video/snapshot path is returned.
- Verification:
  - `yarn test test/camera/infrastructure/in-memory-media.repository.test.ts` - passed
  - `yarn build` - passed
