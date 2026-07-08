# Motion Runtime Fixes Final Review Follow-Up

Date: 2026-07-08
Worktree: `/Users/cagyo/projects/matapi_ai/worker`
Branch: `master`

## Scope

Addressed the two final review findings in the requested four files only:

1. Redacted credential-bearing snapshot source URLs from warning logs in `src/camera/infrastructure/ffmpeg-snapshot.adapter.ts`.
2. Made desired-state reads fail open in `src/camera/application/motion-watcher.service.ts` so transient `system_meta` read failures do not abort watcher recovery.

No adjacent source changes were required.

## Files Changed

- `src/camera/infrastructure/ffmpeg-snapshot.adapter.ts`
- `test/camera/infrastructure/ffmpeg-snapshot.adapter.test.ts`
- `src/camera/application/motion-watcher.service.ts`
- `test/camera/application/motion-watcher.service.test.ts`

## Implementation Notes

### Snapshot adapter

- Added source/message redaction before warning logs are emitted.
- Sanitizes credential-bearing URLs in both:
  - the `snapshot via ... failed` source label
  - the wrapped error message text, which may include the ffmpeg input URL
- Added a focused regression test using `rtsp://user:pass@cam.local/stream` and asserting the warning log does not contain `user:pass`.

### Motion watcher

- Added `isMotionDesiredOff()` helper to centralize desired-state reads.
- Helper catches `meta.get()` failures, logs `Failed to read motion desired state; assuming on: ...`, and returns `false`.
- Replaced direct desired-state reads in:
  - tick-time pre-restart guard
  - retry/backoff loop guard
- Added focused regression tests covering read failure:
  - at tick start
  - during retry/backoff

## Tests Run

### 1. `yarn test test/camera/infrastructure/ffmpeg-snapshot.adapter.test.ts`

Result: pass

Key output:

```text
RUN  v2.1.9 /Users/cagyo/projects/matapi_ai/worker
WARN [FfmpegSnapshotAdapter] snapshot via http://127.0.0.1:8081 failed: Failed to capture snapshot for 'Front door': cannot open http://127.0.0.1:8081
WARN [FfmpegSnapshotAdapter] snapshot via rtsp://cam.local/stream failed: Failed to capture snapshot for 'Front door': cannot open rtsp://cam.local/stream
✓ test/camera/infrastructure/ffmpeg-snapshot.adapter.test.ts (6 tests)
Test Files  1 passed (1)
Tests  6 passed (6)
```

### 2. `yarn test test/camera/application/motion-watcher.service.test.ts`

Result: pass

Key output:

```text
RUN  v2.1.9 /Users/cagyo/projects/matapi_ai/worker
LOG [MotionWatcherService] Motion daemon restarted (attempt 1)
ERROR [MotionWatcherService] Motion daemon down and could not be restarted
LOG [MotionWatcherService] Motion daemon recovered
✓ test/camera/application/motion-watcher.service.test.ts (10 tests)
Test Files  1 passed (1)
Tests  10 passed (10)
```

## Git Notes

- Left unrelated untracked `docs/superpowers/` content untouched.
- Created a follow-up commit as requested; no amend used.

## Concerns

None.
