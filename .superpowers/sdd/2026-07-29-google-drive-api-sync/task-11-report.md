# Task 11 — Archive lifecycle orchestration report

## Implementation

- Added `ArchiveSchedulerService` with non-overlapping ticks, short durable
  attempt claims, one detached active transfer, backup-first admission, and a
  fixed newer-video burst before an older retry is forced into service.
- Added first-attempt dispatch for newly registered artifacts. The repository
  selects only artifacts with no attempt row; the upload use case still owns
  remote-ID reservation and durable attempt creation. Existing attempts use a
  preclaimed upload entrypoint so the scheduler never claims the same lease
  twice.
- Backup creation, Motion reconciliation, local cleanup, and future remote
  maintenance run outside the transfer wait. A stalled upload therefore cannot
  hold a global lock or stop unrelated maintenance.
- Added `ArchiveRemoteMutationLockService`. It serializes only closures supplied
  by reconciliation/retention callers; discovery and long transfers remain
  outside the lock.
- Added `ArchiveRuntimeLifecycleService` with deterministic boot order:
  expire every restart-unsafe staged workflow; finish retiring generations
  before disconnecting generations; release their leases/sessions; recover
  expired active leases; run Motion and registered remote reconciliation; clean
  safe backup temporary files using the unverified-path pin set; run the
  elapsed-24-hour catch-up backup; then enable timers.
- Shutdown now stops timer admission, cancels device-code polling, aborts the
  lifecycle and upload HTTP signals, and waits only for a bounded transfer
  recovery transition. It does not mark attempts abandoned or erase resumable
  state.
- Rebuilt `ArchiveModule` as the Task 1–10 composition root. Production binds
  Drizzle/filesystem/Google adapters; tests bind the in-memory credential and
  manifest repositories. It exports port tokens, connection use cases, runtime
  lifecycle, and registration seams, not concrete adapters.
- Moved authorization polling and Drive connection use-case construction from
  Telegram into Archive. Telegram registers its outcome adapter through an
  Archive-owned runtime registry, so Archive has no Telegram infrastructure
  dependency.
- Camera registers Motion reconciliation and local cleanup through the
  Archive-owned scheduler hook registry. The legacy camera recovery/Drive timer
  providers are no longer active, avoiding duplicate schedules.
- `prepareApplicationShutdown` now shuts Archive down after live streams and
  before the general event/offline-notice shutdown.
- `BootRecoveryService` accepts the Archive recovery gate without introducing a
  System→Archive module cycle, so online diagnostics cannot pass the Archive
  boot sequence.
- Restored the previously reported Telegram application bootstrap gate by
  exporting `RtspSourceStartGate` and making workflow-registry/navigation class
  injections explicit. The composition test now fails normally rather than
  aborting the Vitest worker when Nest reports a DI error.

## TDD evidence

The exact Task 11 command was run after adding the tests and before production
orchestration existed. All four suites failed to load the missing scheduler and
lifecycle modules, establishing the intended RED state.

After initial GREEN, the required integration test exposed the existing
`RtspSourceStartGate` export gap and then undefined optional workflow injections.
Those failures drove the narrow Camera/Telegram composition repair.

A later regression demonstrated that a scheduler which claims only existing
attempts never uploads a newly registered artifact. Before the repository
selection and dispatch change, the focused scheduler suite failed 2 tests: no
unattempted artifact was selected and no first upload started. The focused
scheduler/persistence run then passed 21/21.

## Verification

```text
yarn test test/archive/application/archive-scheduler.service.test.ts \
  test/archive/application/archive-runtime-lifecycle.service.test.ts \
  test/archive/archive-composition.test.ts \
  test/system/application/prepare-application-shutdown.test.ts
4 files passed; 11 tests passed

yarn test test/archive \
  test/system/application/prepare-application-shutdown.test.ts \
  test/camera/camera-composition.test.ts \
  test/telegram/telegram.module.composition.test.ts
23 files passed; 161 tests passed

yarn build
exit 0

yarn eslint <Task 11 source, tests, and bootstrap-composition repair paths>
exit 0

git diff --check
exit 0 (the repository's existing fsmonitor IPC warning was printed)
```

## Scope and deferred dependency

Task 12 is intentionally not implemented here. In particular, this task does
not create/export `ARCHIVE_VERIFICATION`, `ReconcileDriveUseCase`,
`VerifyArchiveArtifactUseCase`, or remote retention behavior. Task 11 exposes a
provider-neutral remote-maintenance hook and the narrow mutation lock; Task 12
must bind its verification/reconciliation use cases into that hook and export
its own verification port.

Existing unrelated worktree changes were preserved. The Task 9 unverified-path
repository additions already present in the shared worktree are consumed by
boot stale-temporary cleanup and backup pinning.

## Review repair — shutdown fencing and deterministic recovery

- Replaced the scheduler's boolean tick guard with a tracked tick promise.
  Shutdown now aborts and bounded-settles both maintenance and transfer work.
- Added cancellation checkpoints around transfer selection. A durable attempt
  claimed concurrently with shutdown is returned to `retryable` immediately
  with its resumable session intact instead of remaining leased until expiry.
- Timer-dispatched ticks now catch and safely log claim/repository failures,
  preventing unhandled promise rejections.
- Boot recovery now checks cancellation between every durable transition,
  bounded-settles the active boot promise before scheduler teardown, and sorts
  equal-status maintenance by creation time and connection ID.
- Camera scheduler bindings now propagate the archive cancellation signal.
  Motion reconciliation and local cleanup stop at checkpoints between file,
  database, retention, Motion-daemon, and alert operations.

The repair was driven by six failing regression assertions covering same-status
ordering, boot fencing, active tick settling, post-abort claim release, timer
dispatch failure handling, and camera maintenance cancellation.

```text
yarn test test/archive/application/archive-scheduler.service.test.ts \
  test/archive/application/archive-runtime-lifecycle.service.test.ts \
  test/camera/application/register-completed-motion-videos.use-case.test.ts \
  test/camera/application/cleanup-local-storage.use-case.test.ts
4 files passed; 42 tests passed

yarn test test/archive \
  test/system/application/prepare-application-shutdown.test.ts \
  test/camera/camera-composition.test.ts \
  test/camera/application/register-completed-motion-videos.use-case.test.ts \
  test/camera/application/cleanup-local-storage.use-case.test.ts \
  test/telegram/telegram.module.composition.test.ts
25 files passed; 195 tests passed

yarn build
exit 0

yarn eslint <repair source and test paths>
exit 0

git diff --check
exit 0 (the repository's existing fsmonitor IPC warning was printed)
```
