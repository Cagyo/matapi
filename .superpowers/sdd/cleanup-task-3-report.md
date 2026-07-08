What you implemented

- Rewrote `CleanupLocalStorageUseCase` to follow the hardening brief:
  - deletes uploaded event files oldest-first and stops once disk usage falls below `threshold - 5`
  - only marks `localDeleted=true` when every referenced local file deletion succeeds
  - re-measures disk usage after critical cleanup and orphan sweep before deciding whether to run emergency actions
  - cooldown-gates `disk-warning` alerts through `system_meta` for 24h and `emergency-disk-cleanup` alerts for 6h
  - gates orphan sweeping on a recent Drive sync success, skips DB-referenced paths, and requires both `mtimeMs` and `ctimeMs` to predate the last success by the rclone min-age margin
  - records `MOTION_DESIRED_STATE_KEY=off` before stopping Motion during emergency cleanup
- Replaced the focused test file with the brief’s full regression suite covering hysteresis, acknowledged marking, re-measurement, cooldowns, and orphan-sweep safety.

Tests run and results

- `yarn test test/camera/application/cleanup-local-storage.use-case.test.ts`
  - RED: failed with 6 assertion failures / 7 passes
  - GREEN: passed with 13/13 tests
- `yarn test`
  - passed with 112/112 files and 520/520 tests

TDD Evidence: RED command/output summary and GREEN command/output summary

- RED command: `yarn test test/camera/application/cleanup-local-storage.use-case.test.ts`
  - Exit code: 1
  - Summary: 6 failed, 7 passed, 13 total
  - Expected behavioral failures observed:
    - partial delete failure still marked event local-deleted
    - cleanup deleted all uploaded events instead of stopping below threshold-hysteresis
    - emergency path ran without re-measuring after cleanup
    - warning and emergency alerts were sent again without cooldown gating
    - orphan sweep behavior was missing
- GREEN command: `yarn test test/camera/application/cleanup-local-storage.use-case.test.ts`
  - Exit code: 0
  - Summary: 13 passed, 0 failed
- Full verification command: `yarn test`
  - Exit code: 0
  - Summary: 112 passed files, 520 passed tests

Files changed

- `src/camera/application/cleanup-local-storage.use-case.ts`
- `test/camera/application/cleanup-local-storage.use-case.test.ts`
- `.superpowers/sdd/cleanup-task-3-report.md`

Self-review findings

- The implementation matches the brief’s full-file replacement, including the new `GDRIVE_SYNC_HEALTH` dependency, cooldown keys, hysteresis constant, and orphan-sweep gating logic.
- Focused and full-suite verification were both rerun after implementation with clean results.
- I did not modify unrelated local changes in `AGENTS.md` or `docs/superpowers/`.

Issues/concerns

- None from this task’s owned scope. Full test suite is green in the current workspace.

## Fix follow-up: review findings hardening

Changes made

- Hardened emergency cleanup in `src/camera/application/cleanup-local-storage.use-case.ts` so `system_meta` persistence for `motion_desired_state=off` is best-effort: failures now log a warning and cleanup still proceeds to `motion.stop()` and the emergency alert flow.
- Refactored cooldown alert handling so alert timestamps are written only after `adminAlert.alert(...)` resolves successfully. Failed alert delivery now logs a warning and does not write the cooldown key, allowing later retries without aborting cleanup/emergency work already performed.
- Made cooldown metadata reads/writes non-fatal: failures log warnings instead of aborting the use case.
- Updated `test/camera/application/cleanup-local-storage.use-case.test.ts` with focused regression coverage for:
  - emergency cleanup resilience when desired-state persistence fails
  - warning cooldown not persisting on alert failure
  - emergency cooldown not persisting on alert failure
  - oldest-first cleanup assertion in the hysteresis case
- Corrected the `uploadedEvent()` helper comment to match the timestamp ordering used by the test fixture.

Verification results

- `yarn test test/camera/application/cleanup-local-storage.use-case.test.ts`
  - RED: exit 1, `3 failed | 13 passed (16)`
  - GREEN: exit 0, `16 passed (16)`
- `yarn test`
  - exit 0, `112 passed (112)` test files, `523 passed (523)` tests
- `yarn lint`
  - exit 0, no output
- `yarn build`
  - exit 0, no output
