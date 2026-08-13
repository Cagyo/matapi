# Motion Video Recovery Registration

> **Date:** 2026-08-13
> **Status:** approved design
> **Scope:** make completed Motion video registration recover reliably after
> the file-stability deferral, without overlapping reconciliation work

## 1. Goal

Every completed Motion video that passes the existing trusted-file checks must
eventually become an `archive_artifacts` row and enter the existing Google Drive
attempt pipeline. Registration must recover after restarts and after the
intentional 60-second file-stability delay.

The change must preserve the current security boundary: exact Motion root,
no-follow path inspection, immutable file identity, bounded streaming SHA-256,
installation-scoped fingerprints, and idempotent manifest registration.

## 2. Confirmed defect

Production evidence from the Raspberry Pi established each boundary:

1. Motion emits the configured
   `YYYY/MM/DD/HHMMSS-%{eventid}.avi` path and records completed database rows.
2. The `homeworker` process can read both the installation identity and video
   bytes; the installation identity is a valid UUID.
3. The deployed `FsCompletedMotionVideoAdapter` resolves a sample video and
   scans the Motion tree successfully.
4. A read-only execution of the deployed
   `RegisterCompletedMotionVideosUseCase` against the active database selected
   88 valid registrations with no deferrals.
5. The live database contained 265 completed video rows but zero
   `motion_video` archive artifacts.
6. The archive scheduler continued updating its reconciliation-success time,
   proving that its Camera hook returned successfully while doing no work.

`on_movie_end` invokes immediate registration before the 60-second stability
window has elapsed. That deferral is correct. The defect is that the later
Camera-to-Archive recovery hook is ineffective in the deployed application, so
no component retries the deferred videos. The previous Camera-owned
`CompletedMotionVideoRecoveryScheduler` still exists and is tested, but it was
removed from `CameraModule` when archive orchestration was centralized.

The separately observed `Google resumable Location is not allowlisted` warning
belongs to the upload boundary and is already fixed by the opaque-session-URI
change. It does not explain the absence of motion artifacts from the manifest.

## 3. Approved design

Restore `CompletedMotionVideoRecoveryScheduler` as the Camera-owned lifecycle
coordinator for completed-video discovery. Both its own boot/interval triggers
and the Archive scheduler hook will call one public reconciliation method on
that coordinator.

The coordinator owns one shared in-flight promise:

- the first caller starts `RegisterCompletedMotionVideosUseCase.reconcile()`;
- an overlapping caller receives the same promise instead of starting another
  filesystem scan or manifest registration pass;
- the promise is cleared in `finally`, allowing the next recovery pass;
- stub mode remains a no-op and performs no filesystem work.

Camera boot and the existing two-minute interval dispatch the method
best-effort and log a sanitized failure. The Archive hook awaits the same method
with its shutdown signal, so Archive records reconciliation success only after
the shared pass completes and retains its existing cancellation behavior.

`CameraModule` will:

1. provide `CompletedMotionVideoRecoveryScheduler` again; and
2. inject that coordinator, rather than the raw registration use case, into the
   `ARCHIVE_CAMERA_SCHEDULER_HOOK_REGISTRATION` factory.

The cleanup half of the Camera hook remains unchanged and continues to route
through `CleanupCoordinatorService`.

## 4. Runtime flow

1. Motion closes a movie and calls `on_movie_end` with the full path.
2. `RecordMotionEndUseCase` records the completed event.
3. Immediate registration rejects the still-recent file and leaves
   `archive_artifact_id` null as the durable deferred state.
4. Camera boot recovery or the next two-minute trigger calls the shared
   completed-video recovery coordinator.
5. The coordinator scans pending event paths and the trusted Motion root.
6. Stable files are registered idempotently and their event rows are attached
   to the resulting artifact.
7. The existing Archive scheduler selects the new `motion_video` artifact and
   runs the unchanged resumable Drive upload and verification pipeline.

If Camera boot recovery and the Archive interval arrive together, they await
one reconciliation pass. A restart repeats discovery safely because the source
fingerprint and manifest registration are idempotent.

## 5. Errors and shutdown

- A detached boot/interval trigger logs `Completed Motion recovery failed`
  without file paths, installation IDs, Drive IDs, or credentials.
- An Archive-triggered failure propagates to `ArchiveSchedulerService.runJob`,
  so `last_reconcile_success_ms` is not advanced for a failed pass.
- Archive shutdown continues to pass its existing `AbortSignal` into the
  reconciliation use case.
- Cancellation, invalid files, unstable files, source changes, and missing
  files retain their current fail-closed behavior.
- No database schema, migration, Motion configuration, Drive API behavior, or
  local-cleanup policy changes.

## 6. Tests

Application tests will prove that:

1. boot recovery starts reconciliation in real mode;
2. interval and Archive-hook callers share one in-flight reconciliation
   promise rather than overlap;
3. the next pass can start after the shared promise settles;
4. the Archive hook forwards its cancellation signal; and
5. stub mode performs no reconciliation.

A Camera composition regression test will prove that the module provides the
recovery coordinator and routes `reconcileMotion` through it. Existing
completed-file adapter, registration use-case, archive scheduler, and cleanup
tests remain unchanged except where their factory dependency changes.

On-device verification will use aggregate-only reads:

- `motion_video` artifacts become nonzero;
- completed `motion_events` gain archive references;
- motion attempts enter `pending`, `retryable`, or `verified` state; and
- no new completed-video recovery error appears in application logs.

## 7. Non-goals

- weakening completed-file validation;
- changing the 60-second stability window;
- rewriting Motion filenames or existing media;
- changing backup/video transfer priority;
- repairing the unrelated absolute `DATABASE_PATH` configuration in this
  change; or
- deleting or resetting any local database or archive state.
