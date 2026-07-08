# Task 3 Report: Upload marking aligned with rclone `--min-age`

## Implementation summary

- Replaced `test/camera/application/upload-motion.use-case.test.ts` with the brief's full test file, including the new `MediaFilePort` fake and the fresh-video, fresh-snapshot, and missing-file coverage.
- Updated `src/camera/application/upload-motion.use-case.ts` to inject `MediaFilePort` and gate upload marking on file mtimes matching the same `UPLOAD_MIN_AGE_MS` cutoff used by rclone's `--min-age`.
- Preserved the Task 2 async health writes by continuing to `await` `recordSuccess()` and `recordFailure()`.
- Added a warning log when a pending upload's local video file is already missing, and left missing snapshots non-blocking per the brief.

## RED evidence

### Command

```bash
yarn test test/camera/application/upload-motion.use-case.test.ts
```

### Result

- Failed as expected.
- Failure mode was assertion failures, not constructor/arity/type errors.

### Key failing assertions

1. `does not mark an event whose file mtime is too fresh for --min-age`
   - Expected uploaded ids: `[2]`
   - Received: `[1, 2]`
2. `does not mark an event whose snapshot is too fresh for --min-age`
   - Expected uploaded ids: `[2]`
   - Received: `[1, 2]`
3. `does not mark an event whose local file is missing`
   - Expected `copyMotionFiles` not to be called
   - Received: called once

## GREEN evidence

### Focused command

```bash
yarn test test/camera/application/upload-motion.use-case.test.ts
```

### Focused result

- Passed: `7/7` tests

## Full verification

### Commands

```bash
yarn test
yarn lint
```

### Results

- `yarn test`: passed `110/110` files, `506/506` tests
- `yarn lint`: passed with no output

## Files changed

- `src/camera/application/upload-motion.use-case.ts`
- `test/camera/application/upload-motion.use-case.test.ts`

## Self-review

- The use case now only marks events after confirming the video exists and its mtime is old enough for rclone to have copied it.
- Snapshot freshness is treated the same way as video freshness, but a missing snapshot does not block marking.
- The cycle still returns early without calling `copyMotionFiles()` when nothing is eligible, matching the brief's deliberate trade-off around stale `lastSuccessAt`.
- Changes stayed within the two owned files requested by the task.

## Concerns

- No functional concerns from the implemented scope.
- There is an unrelated untracked `docs/superpowers/` directory in the worktree; it was left untouched.
