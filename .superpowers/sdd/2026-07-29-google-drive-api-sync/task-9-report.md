# Task 9 — Publish consistent database snapshots and pin local backups

## Implementation

- Added `DATABASE_BACKUP_SNAPSHOT` and database-owned immutable backup descriptors.
- Added production and in-memory snapshot adapters. The production path creates a
  same-directory temporary SQLite online backup, requires `PRAGMA quick_check = ok`,
  fsyncs the file, atomically renames it, then fsyncs the directory.
- Added root-contained stale temporary cleanup, completed-snapshot listing, and
  seven-day local retention that never removes supplied pinned paths.
- Added `CreateDatabaseBackupUseCase` with a short durable CAS lease, elapsed
  24-hour catch-up, IANA-timezone local-day scheduling helper, archive registration
  after local publication, installation-bound source fingerprints, and release of
  the lease on either outcome. It does not acquire a transfer semaphore.
- Added repository support for reading every unverified artifact path, so pruning
  pins all pending local archive sources.
- Removed the legacy camera/database backup service, ports, adapters, scheduler
  cron hook, and their obsolete tests.

## TDD evidence

RED command (before implementation):

```text
yarn test test/database/infrastructure/better-sqlite3-backup-snapshot.adapter.test.ts test/archive/application/create-database-backup.use-case.test.ts
No test files found, exiting with code 1
```

After adding the Task 9 test files but before production files existed, the same
command failed to load both new adapter/use-case modules. That established the
expected missing-feature failure. The focused suite then passed 7/7 tests.

## Verification

```text
yarn test test/database/infrastructure/better-sqlite3-backup-snapshot.adapter.test.ts test/archive/application/create-database-backup.use-case.test.ts
7 tests passed

yarn test test/database test/archive/application/create-database-backup.use-case.test.ts
29 tests passed

yarn test test/database/infrastructure/better-sqlite3-backup-snapshot.adapter.test.ts test/archive/application/create-database-backup.use-case.test.ts test/database test/archive/infrastructure/drizzle-archive-artifact.repository.test.ts
43 tests passed

yarn build
exit 0

yarn db:generate
No schema changes, nothing to migrate

git diff --check
exit 0
```

`yarn test` was also attempted. It reached unrelated live-stream Unix-socket
tests and failed in the sandbox with `listen EPERM` / Python `PermissionError:
[Errno 1] Operation not permitted` at `sock.bind(...)`. The requested escalation
was rejected by the environment due to its usage limit, so no unrestricted rerun
was possible. This does not affect the focused Task 9 verification above.

## Scope and migration check

- No database schema changed; `yarn db:generate` reported no migration drift.
- `git diff --check` found no whitespace errors.
- Existing unrelated worktree changes were left untouched.

## Race repair — 2026-08-01

### Regression-first evidence

Before changing the adapter, I added adversarial tests for (1) an `EEXIST`
collision during temporary-file reservation, (2) a final file published by a
second process after the initial existence check, and (3) cleanup of the new
UUID-suffixed temporary-file shape. The regression command failed as expected:

```text
yarn test test/database/infrastructure/better-sqlite3-backup-snapshot.adapter.test.ts
4 failed / 2 passed
- reservation used the old exists-then-create path
- publish used clobbering rename semantics
- UUID-suffixed temporary files were not selected for stale cleanup
```

### Repair

- Temporary snapshots use a collision-resistant UUID suffix and are reserved
  with `open(..., 'wx')` before `better-sqlite3.backup` writes bytes.
- `EEXIST` is retried with a new UUID; no backup writes into a pre-existing
  temporary path.
- Publication uses an atomic same-filesystem hard-link (`link`) no-replace
  operation. An existing final therefore wins and is returned unchanged;
  the losing temporary file is removed. This avoids `rename(2)` replacement
  semantics across independent processes.
- The successful publication order is quick check → file fsync → no-replace
  publish → directory fsync → temporary unlink → directory fsync.
- Stale cleanup recognizes the UUID-suffixed staging names while retaining
  exact-root containment and referenced-path protection.

### Repair verification

```text
yarn test test/database/infrastructure/better-sqlite3-backup-snapshot.adapter.test.ts test/archive/application/create-database-backup.use-case.test.ts
9 tests passed

yarn test test/database test/archive/application/create-database-backup.use-case.test.ts
31 tests passed

yarn build
exit 0

yarn db:generate
No schema changes, nothing to migrate

git diff --check
exit 0
```

### Task 11 dependency

Task 9 deliberately exposes `DATABASE_BACKUP_SNAPSHOT` plus
`CreateDatabaseBackupUseCase` (including elapsed-24-hour catch-up and
IANA-zone daily scheduling helpers). Task 11 owns all ArchiveModule binding,
boot stale-temp cleanup/catch-up invocation, and periodic timer dispatch; this
repair adds none of that lifecycle wiring.
