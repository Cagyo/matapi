# Task 0 — Baseline repair report

## Scope

Repaired only the two stale test fixtures responsible for the five documented
baseline failures. No Google Drive implementation work was started.

Primary repair commit: `35c7ec114c0f8e70cb755de34cabd9374d24f3bf`

## Initial worktree check

`git status --short` showed an already-dirty worktree across Drive, feature,
archive, docs, and other test files. Those changes were preserved. The only
repair files changed by this task are:

- `test/e2e/application-smoke.test.ts`
- `test/system/infrastructure/motion-install-script.test.ts`
- this report

`git diff --check` passed for the repair diff. Git emitted an unrelated
`fsmonitor_ipc__send_query` warning while reading status/diff; it did not
prevent inspection or testing.

## Root-cause evidence and hypothesis

### E2E readiness failures

The initial focused RED run failed both the sensor and camera flows in
`FeatureAvailabilityService.requireReady()` with `FeatureUnavailableError`.

Tracing the data flow showed:

1. `FeatureSeederService` creates disabled/uninstalled rows when the fresh E2E
   database has no validated `features.json` selection.
2. The existing E2E fixture only set `NODE_ENV=test`, `CAMERA_MODE=stub`, and
   `PIGPIOD_ENABLED=false`; it did not seed the `digital` and `motion` feature
   state required by the two exercised flows.
3. The real digital and Motion readiness adapters deliberately probe
   Raspberry-Pi-only processes/files. They cannot represent ready hardware in
   the macOS test environment, even when the features are enabled.

Working unit tests establish that availability waits for readiness, and that
ready, installed, enabled state is required. The hypothesis was therefore:
the smoke fixture is stale after readiness gating was introduced, and must set
the exercised features to installed/enabled and make the feature-readiness
port report ready. Production readiness behavior must remain unchanged.

The initial fixture update made the camera flow pass and exposed an older
race in the sensor test: `waitForIdle()` can run before the asynchronous
driver-to-registry handoff queues processor work. The fixture now waits for the
observable notification before waiting for processor idle, which verifies the
full sensor pipeline instead of weakening the assertion.

### Installer harness failures

The initial RED output showed that each harness sourced `install.sh`, then
executed `main`, reaching `setup_hardware_resources`; macOS lacks `free`, and
the attempted `/swapfile` creation is denied.

The current installer has an established library pattern:

```bash
if [ "${HOME_WORKER_INSTALL_LIBRARY:-0}" != "1" ]; then
  main "$@"
fi
```

The three harnesses still tried to remove an old exact `main "$@"` footer with
`script.replace(...)`; this no longer matches the guarded footer. The
hypothesis was that setting the established `HOME_WORKER_INSTALL_LIBRARY=1`
contract in each harness would source functions hermetically and prevent all
install-entrypoint side effects.

## RED

Command:

```bash
yarn vitest run test/e2e/application-smoke.test.ts test/system/infrastructure/motion-install-script.test.ts
```

Result: 2 failed test files, 5 failed / 11 passed tests.

- E2E sensor and camera cases failed with `FeatureUnavailableError` at
  `FeatureAvailabilityService.requireReady`.
- All three shell harnesses printed `free: command not found`, then
  `dd: /swapfile: Operation not permitted`, and failed before invoking the
  target function.

After the first minimal fixture change, the three installer cases were green;
the camera case was green; the sensor test failed its real state assertion:
`expected null to be '1'`. That isolated the asynchronous handoff race and
motivated the final, test-only readiness wait.

## GREEN

Command:

```bash
yarn vitest run test/e2e/application-smoke.test.ts test/system/infrastructure/motion-install-script.test.ts
```

Output:

```text
Test Files  2 passed (2)
     Tests  16 passed (16)
Duration  3.48s
```

## Full suite

Command (run outside the sandbox with approval for local socket binding):

```bash
yarn test
```

The command completed successfully. Its captured output exceeded the terminal
capture limit, but it included successful runs of both repaired files:

```text
✓ test/e2e/application-smoke.test.ts (7 tests)
✓ test/system/infrastructure/motion-install-script.test.ts (9 tests)
```

The suite's expected test logger diagnostics (simulated failures, hardware
availability warnings, and Cloudflare architecture warnings) were emitted;
no failing test record appeared before completion. The focused GREEN command
above supplies the complete non-truncated output for the repair scope.

## Changes

- The E2E fixture explicitly marks its `digital` and `motion` features
  installed/enabled, stubs only the feature-readiness port at the E2E boundary,
  and synchronizes on notification before reading persisted state.
- The three shell harnesses opt into the installer’s existing function-library
  mode before sourcing the script, preventing `main` side effects.

## Self-review

- The production feature-readiness service and adapters were not modified.
- The tests retain all original behavior assertions; none were skipped,
  deleted, or weakened.
- The readiness stub remains confined to the E2E fixture and preserves the
  intended production verification contract.
- The shell tests execute real sourced functions with controlled inputs rather
  than asserting script text alone.
- Only the listed repair files are intended for staging; pre-existing dirty
  files remain unstaged.

## Concerns

- The full-suite terminal stream was truncated by the tool’s output cap, so
  Vitest's final aggregate line was unavailable even though the command
  completed successfully. The fresh focused run has complete output.
- Existing unrelated working-tree changes remain intentionally untouched.
