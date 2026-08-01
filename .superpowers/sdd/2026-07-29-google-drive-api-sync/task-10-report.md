# Task 10 — Stream and resume immutable Drive object attempts

## Status

Implemented exact-ID Google Drive object uploads with crash-safe resumable
sessions, one fair priority transfer slot, immutable conflict recovery, and
atomic private-object verification. Task 11 wiring and lifecycle scheduling
were not started.

## TDD evidence

The three required test files were created before production code. The first
focused run failed with all three suites unable to resolve the missing gateway,
semaphore, and use-case modules:

```text
yarn test test/archive/infrastructure/google-resumable-upload.gateway.test.ts test/archive/application/archive-transfer-semaphore.service.test.ts test/archive/application/upload-drive-object-attempt.use-case.test.ts
3 test files failed / 0 tests collected
```

After the protocol implementation, the same focused command passed:

```text
3 test files passed / 30 tests passed
```

The matrix covers clean upload, generated-ID-before-initiation ordering,
encrypted-session-before-bytes ordering, 200/201/308/404 session recovery,
process restart, stale leases, server-authoritative offset rollback and local
prefix hashing, ambiguous creation, ID conflict replacement, expired sessions,
source mutation, checksum/revision mismatch, bounded 256 KiB reads, abort, no
duplicate attempt, strict Location validation, transport deadlines, single-slot
priority, FIFO, fairness, and aborted semaphore waiters.

## Implementation

- Added the provider-neutral `DriveArchivePort`. Application code exposes
  `AsyncIterable<Uint8Array>` only; Google SDK and Node stream types remain in
  archive infrastructure.
- Added `GoogleDriveArchiveAdapter` for generated IDs, exact metadata reads,
  bounded listing, exact deletion, and direct resumable delegation. Provider
  metadata is normalized to the existing private-object value contract.
- Added `GoogleResumableUploadGateway` and a streaming Node HTTPS transport.
  Initiation, status, and chunk requests have connect, response, idle, and total
  deadlines plus caller cancellation. Persisted session URLs accept only HTTPS
  `www.googleapis.com/upload/drive/v3/files`, exactly one
  `uploadType=resumable`, exactly one nonempty `upload_id`, no credentials, no
  fragment, no port, and no other query parameters.
- Added `ArchiveTransferSemaphoreService`: exactly one active transfer, FIFO
  within priority, backup priority, and a bounded backup burst so video cannot
  starve.
- Added `UploadDriveObjectAttemptUseCase`. First execution from an artifact ID
  generates and persists the exact Drive ID before initiation; execution from
  an attempt ID resumes the same immutable reservation. It claims a fenced
  lease, validates/re-stats the source, encrypts the session URI with
  installation/attempt/kind/schema AAD before sending bytes, renews the lease,
  persists only server-confirmed offsets, hashes local prefixes on resume, and
  streams fixed 256 KiB chunks with bounded memory.
- Verification requires the transferred/local/artifact/Drive SHA-256 values to
  agree, exact size/name/MIME/parent/properties, a nonempty binary revision,
  private ownership, deletion capability, no trash, and exactly the owner
  permission. The final source re-stat and manifest verification commit occur
  through the existing atomic repository transition.
- Ambiguous initiation loads only the exact reserved ID. A present exact object
  is verified without duplication. A true ID conflict terminalizes the old row
  as `conflict` and persists a newly generated ID in a new pending row; attempt
  IDs and remote IDs are never overwritten or reassigned. An expired session
  reuses its still-free immutable ID and creates no duplicate row.
- Added a bounded filesystem source adapter and extended the existing AES-GCM
  secret purpose allowlist with `upload-session`.
- Added exact-attempt load/claim and leased conflict transitions to both durable
  and in-memory artifact repositories. No schema or migration changed.

## Verification

```text
yarn test test/archive
17 test files passed / 116 tests passed

yarn build
exit 0

yarn eslint <Task 10 source and test paths>
exit 0

git -c core.fsmonitor=false diff --check
exit 0
```

The first scoped lint pass reported ten deterministic type/style findings in
new files. Each was corrected and the identical scoped lint command then exited
0. Existing unrelated worktree changes, including concurrent Task 9 manifest
pinning hunks in shared repository files, were preserved and excluded from the
Task 10 commit.
