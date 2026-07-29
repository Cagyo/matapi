# Task 4 — Durable archive artifact manifest

## Delivered

- Added the provider-neutral `ArchiveArtifactRepositoryPort`, including
  immutable artifact registration, append-only Drive attempts, fenced attempt
  leases, encrypted resumable-upload session state, reconciliation and
  retention reads, generation lease release, and revision-CAS scheduler state.
- Added Drizzle and in-memory adapters. The Drizzle adapter takes immediate
  transactions for queue claims and verification, and every lease mutation is
  fenced by attempt ID, revision, owner, and expiry.
- Added `archive_artifacts`, `drive_object_attempts`, and the singleton
  `archive_scheduler_state` tables. They enforce source fingerprint and remote
  file ID uniqueness, lease/session envelopes, verified-metadata completeness,
  scheduler lease consistency, and a unique current verified-attempt pointer.
- Generated migrations `0011_jazzy_omega_flight.sql` and
  `0012_sturdy_joystick.sql`; the second migration adds the generated unique
  current-verified-attempt index after its schema constraint was tightened.

## TDD evidence

Initial RED command:

```text
yarn test test/archive/infrastructure/drizzle-archive-artifact.repository.test.ts test/database/archive-manifest-migration.test.ts
```

It failed as expected: the repository module did not exist and the three
manifest tables were absent.

Focused GREEN command:

```text
yarn test test/archive/infrastructure/drizzle-archive-artifact.repository.test.ts test/database/archive-manifest-migration.test.ts
```

Result: 2 files passed, 5 tests passed. Coverage includes historical attempt
preservation, expired-lease fencing, verification persistence, scheduler CAS,
unique IDs/fingerprints, and incomplete verified-row rejection.

## Verification

```text
yarn build
git diff --check
```

Both completed successfully. Git emitted its pre-existing fsmonitor IPC warning
during `diff --check`, but the command exited successfully.

## Scope

No Task 5 work was started. The changes are limited to the Task 4 archive
manifest port/adapters, schema/migrations, and focused tests.

## Corrective review pass

- The application port now exposes provider-neutral archive attempt and remote
  snapshot records. Drive entity/metadata conversion is isolated in the
  persistence adapters.
- Claims return persisted encrypted resumable-session state. Verification,
  missing, and detachment clear that envelope atomically with their terminal
  transition; retryable recovery retains it for resume.
- Missing or detached current objects release the artifact's verified pointer,
  allowing a new immutable reservation to become the replacement.
- Expired uploading leases are recovered globally before queue selection and by
  the explicit `recoverExpiredLeases` boot-recovery seam. Lease-owned writes
  now all require a supplied mutation time and fence on that time.
- Queue selection provides backup priority and a fair older-video-retry lane;
  reconciliation is generation-selectable and retention uses provider creation
  time. Attempts persist retry count and the actual retry mutation timestamp.
- Generated migration `0013_wide_puma.sql` adds `retry_count` and its queue
  index support.

### Regression evidence

The added repository regressions were run against the prior implementation and
failed for seven independent paths: missing returned session, blocked
replacement verification, no global expired-upload recovery, unfenced session
write, absent retry count/wrong mutation timestamp, video beating a backup,
and local-time retention ordering.

```text
yarn test test/archive/infrastructure/drizzle-archive-artifact.repository.test.ts test/database/archive-manifest-migration.test.ts
```

GREEN result: 2 files passed, 13 tests passed. A scoped archive plus migration
pass also completed with 8 files / 42 tests passing, followed by `yarn build` and
`git diff --check` (the latter emitted only the pre-existing fsmonitor IPC
warning and exited successfully).
