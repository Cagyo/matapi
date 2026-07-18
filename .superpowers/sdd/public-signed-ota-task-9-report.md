# Public Signed OTA — Task 9 Report

## Outcome

Implemented only the Task 9 prepared-tree and storage-resource gateways. No
preparation orchestrator, installer flow, DI wiring, migration, or unrelated OTA
behavior was added.

## TDD evidence

Initial RED:

```text
corepack yarn test test/system/domain/prepared-tree.test.ts test/system/infrastructure/prepared-tree.gateway.test.ts test/system/infrastructure/storage-budget.gateway.test.ts
Test Files  3 failed (3)
Tests       no tests
Cause: all three planned modules were absent
```

Final focused GREEN:

```text
Test Files  3 passed (3)
Tests       25 passed (25)
```

Task 7–9 regression GREEN:

```text
Test Files  7 passed (7)
Tests       87 passed (87)
```

The regression run included the Task 7 journal/release-path suites and the Task
8 archive/Yarn-cache suites alongside Task 9.

## Prepared-tree behavior

- Canonical SHA-256 input is a raw-UTF-8-path-sorted sequence of four-field,
  unsigned-32-bit-big-endian length-prefixed records: relative path, entry type,
  normalized four-digit octal mode, and file SHA-256/link target (empty for a
  directory).
- Traversal uses `lstat` plus no-follow opens, hashes regular files through their
  opened handles, records links without following them, detects entry identity
  changes, and rejects special entries.
- Allocated bytes use `stat.blocks * 512`; entry totals and byte arithmetic fail
  closed on unsafe-integer overflow.
- Only root regular files named `artifact-state.json`,
  `artifact-envelope.json`, and `known-good.json` are excluded. Nested names,
  similarly named files, and non-file entries remain part of the tree.
- Durable flush syncs every regular file (including updater markers), then every
  directory in post-order, then invokes the required injected filesystem
  barrier. Any failure is mapped to typed `prepared-tree` failure.

## Storage behavior

- The gateway creates the fixed 128 MiB reserve by writing every byte through an
  exclusive no-follow file handle, syncing the file, syncing through the
  injected directory barrier, and verifying exact size plus allocated
  `stat.blocks * 512`.
- Preflight checks available bytes and inodes through injected `statvfs`
  semantics. Byte budgeting includes compressed bytes, declared expansion,
  signed maximum prepared bytes, current and previous allocated bytes, and fixed
  headroom. Inode budgeting includes the artifact, signed maximum prepared
  files, current and previous entry counts, and fixed inode headroom.
- Preparation checkpoints enforce byte and inode low-water levels before,
  throughout (through the supplied checkpoint), and after work.
- On typed low water, `ENOSPC`, or `EDQUOT`, the gateway releases the reserve,
  durably removes the candidate, recreates and verifies the reserve, and returns
  only `disk-resource`.

## Verification

Fresh successful commands:

```text
corepack yarn build
corepack yarn eslint src/system/domain/prepared-tree.ts src/system/infrastructure/prepared-tree.gateway.ts src/system/infrastructure/storage-budget.gateway.ts test/system/domain/prepared-tree.test.ts test/system/infrastructure/prepared-tree.gateway.test.ts test/system/infrastructure/storage-budget.gateway.test.ts
corepack yarn prettier --check src/system/domain/prepared-tree.ts src/system/infrastructure/prepared-tree.gateway.ts src/system/infrastructure/storage-budget.gateway.ts test/system/domain/prepared-tree.test.ts test/system/infrastructure/prepared-tree.gateway.test.ts test/system/infrastructure/storage-budget.gateway.test.ts
git diff --check
```

All exited successfully.

A repository-wide `corepack yarn test` sweep was also attempted. As in the Task
8 report, this sandbox rejects UNIX-domain socket binds with `EPERM`. The
Quick-Tunnel RTSP and FFmpeg-runner suites failed for that reason; dependent
server suites timed out, and the hung run was interrupted after those unrelated
failures were established. No repository-wide pass is claimed.

## Files

- `src/system/domain/prepared-tree.ts`
- `src/system/infrastructure/prepared-tree.gateway.ts`
- `src/system/infrastructure/storage-budget.gateway.ts`
- `test/system/domain/prepared-tree.test.ts`
- `test/system/infrastructure/prepared-tree.gateway.test.ts`
- `test/system/infrastructure/storage-budget.gateway.test.ts`
- `.superpowers/sdd/public-signed-ota-task-9-report.md`

The pre-existing untracked `scripts/__pycache__/` directory was not read,
modified, staged, or removed.

## Review correction: pinned traversal and reserve-establishment pressure

The review identified two boundary gaps and both were corrected without adding
an OTA preparation orchestrator or changing unrelated installer behavior.

- Prepared-tree measurement and durable flush now retain each validated
  directory handle across enumeration and all descendant operations. The
  directory path is revalidated against the pinned inode immediately after
  enumeration, before and after each child path operation, and before the pinned
  directory handle is synced or closed. A deterministic rename-plus-symlink
  regression proves neither operation touches an outside child after the swap.
- Reserve establishment now classifies `ENOSPC` and `EDQUOT` from exclusive
  open, allocation writes, file sync, close, and the directory barrier as
  `disk-resource`. It removes the incomplete reserve durably, attempts one clean
  reserve restoration, and never leaks the raw filesystem resource code.
  Injected preflight regressions cover all five persistence boundaries and
  verify the complete 128 MiB reserve is restored after a one-shot failure.

Review-fix RED:

```text
Test Files  2 failed (2)
Tests       7 failed | 18 passed (25)
Cause: both traversal cases touched the swapped outside child; all five reserve
       boundaries leaked raw ENOSPC from preflight.
```

Review-fix focused GREEN:

```text
Test Files  3 passed (3)
Tests       32 passed (32)
```
