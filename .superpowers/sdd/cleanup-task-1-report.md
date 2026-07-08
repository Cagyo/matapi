# Task 1 Report: LocalStoragePort acknowledged deletes + listFilesOlderThan

## What I implemented
- Extended `LocalStoragePort` with `LocalFileInfo` and a new `listFilesOlderThan(cutoff)` contract.
- Changed `deleteFile(path)` to acknowledge success with `true` and failure with `false`.
- Implemented `FsLocalStorageAdapter.listFilesOlderThan()` as a recursive, safe scan of the Motion directory that returns old regular files with `path`, `mtimeMs`, and `ctimeMs`.
- Updated `FsLocalStorageAdapter.deleteFile()` to return `true` on successful removal or already-absent files, and `false` when deletion fails.
- Updated `StubLocalStorageAdapter` to match the new port contract.
- Updated the cleanup use-case fake storage helper so its typed mock returns `true` from `deleteFile()`.
- Expanded the adapter test coverage to include:
  - acknowledged deletes
  - failed deletes returning `false`
  - recursive old-file listing
  - empty result when the storage root is missing

## Tests run and results
- `yarn test test/camera/infrastructure/fs-local-storage.adapter.test.ts`
  - RED run: failed as expected before implementation
  - GREEN run: passed, 6 tests green
- `yarn lint`
  - passed
- `yarn build`
  - passed

## TDD Evidence
### RED command/output summary
- Command: `yarn test test/camera/infrastructure/fs-local-storage.adapter.test.ts`
- Result: 4 failing tests, 2 passing
- Failure mode matched the brief:
  - `deleteFile()` returned `undefined` instead of `true` / `false`
  - `listFilesOlderThan()` did not exist

### GREEN command/output summary
- Command: `yarn test test/camera/infrastructure/fs-local-storage.adapter.test.ts`
- Result: 6 passing tests, 0 failures
- Follow-up verification:
  - `yarn lint` passed
  - `yarn build` passed

## Files changed
- `/Users/cagyo/projects/matapi_ai/worker/src/camera/domain/ports/local-storage.port.ts`
- `/Users/cagyo/projects/matapi_ai/worker/src/camera/infrastructure/fs-local-storage.adapter.ts`
- `/Users/cagyo/projects/matapi_ai/worker/src/camera/infrastructure/stub-local-storage.adapter.ts`
- `/Users/cagyo/projects/matapi_ai/worker/test/camera/infrastructure/fs-local-storage.adapter.test.ts`
- `/Users/cagyo/projects/matapi_ai/worker/test/camera/application/cleanup-local-storage.use-case.test.ts`

## Self-review findings
- The new adapter method is defensive: unreadable directories, vanished paths, and stat races all resolve to an empty list rather than throwing.
- `deleteFile()` now gives callers an explicit success/failure signal, which matches the cleanup hardening plan.
- The recursive listing only includes regular files older than the cutoff; directories are ignored.

## Issues/concerns
- None from this task. The only warning observed during the test run was the expected `rm` warning when deliberately deleting a directory in the failure-path test.

## Fix: cleanup use-case fake storage typing
- Updated `test/camera/application/cleanup-local-storage.use-case.test.ts` so the local `fakeStorage()` helper also defines `listFilesOlderThan: vi.fn(async () => [])`, keeping the typed fake aligned with the expanded `LocalStoragePort`.

## Verification for this fix
- `yarn test test/camera/infrastructure/fs-local-storage.adapter.test.ts`
  - passed: 6 tests green
  - note: the expected warning still appeared for the directory-delete failure-path test
- `yarn build`
  - passed
