# Public Signed OTA — Task 11 Report

## Outcome

Implemented the prepare-only detached-updater state machine and runtime Drizzle
migration entry. The updater now binds the exact request timestamp and digest
plus receipt generation into the durable operation journal before writing its
fd-3 receipt, re-verifies only the cached trusted envelope at one effective
start time, and ends at a durably flushed `prepared` journal generation.

No PM2 stop/restart, migration execution from the updater, activation, readiness,
rollback, pruning, or `current`/`previous` mutation was added.

## TDD evidence

Initial RED:

```text
corepack yarn test test/system/infrastructure/ota-updater-preparation.test.ts test/system/infrastructure/migrate.entry.test.ts
Test Files  2 failed (2)
Tests       no tests
Cause: ota-updater.service.ts and migrate.entry.ts did not exist
```

Focused and contract-regression GREEN:

```text
Test Files  7 passed (7)
Tests       182 passed (182)
```

The regression run includes the schema-v1 vectors, dual-slot journal, fixed OTA
configuration, launcher, and lock-owning shim in addition to the new Task 11
suites.

## Durable preparation contract

- The schema-v1 journal now carries immutable `acceptedAt`, `requestSha256`,
  and `receiptGeneration` fields. Canonical JSON vectors/checksums and transition
  tests cover all three.
- Any existing selected journal or total journal corruption maps to
  `maintenance-required` before handshake, candidate inspection, deletion, or
  overwrite.
- The first `preparing` generation repeats the exact request identity, prior
  release pointers, fixed artifact-derived candidate basename, and receipt
  binding. The fd-3 receipt is emitted only after `journal.start()` completes.
- After handshake, the service captures one effective trusted time, loads and
  re-verifies the exact cached envelope bytes, checks the complete expected
  release, metadata floor, and immutable artifact-ledger provenance, and never
  fetches or commits trusted metadata.
- New candidates run preflight and low-water checkpoints around download,
  archive extraction, Yarn-cache inspection, the Task 10 preparation boundary,
  installer-owned shared links, final markers, and the prepared-tree flush.
  `prepared` is journaled only after the tree durability barrier succeeds.
- Known-good reuse requires the exact artifact, verified first-authorizing
  envelope provenance, envelope digest, artifact marker, known-good marker, and
  freshly measured prepared-tree digest to agree. It skips download, extraction,
  preparation, marker rewriting, and tree flushing.
- Incomplete candidates may be removed only when the layout boundary proves
  they are not retained by `current` or `previous`. A mismatching known-good
  directory is never removed or overwritten.

## Runtime migration entry

- `dist/system/infrastructure/migrate.entry.js` uses the same
  `createMigratedDatabase()` runtime coordinator as startup and closes SQLite on
  success or failure.
- `db:migrate` runs the compiled JavaScript entry; `drizzle-kit` is now a
  development-only dependency for generation/studio use.
- Nest copies migrations into `dist/migrations`, and the updater configuration,
  shim, tests, and compiled filename consistently use
  `ota-updater.entry.js`.
- A compiled-entry smoke test created and migrated a temporary SQLite database
  successfully. The compiled migration path contains no `drizzle-kit` or
  TypeScript-source dependency.

## Verification

Fresh successful commands:

```text
corepack yarn test test/system/infrastructure/ota-updater-preparation.test.ts test/system/infrastructure/migrate.entry.test.ts test/system/infrastructure/dual-slot-operation-journal.test.ts test/system/domain/ota-contracts.test.ts test/system/infrastructure/ota-discovery-config.loader.test.ts test/system/infrastructure/flock-ota-operation-launcher.adapter.test.ts test/system/infrastructure/ota-lock-acquired-shim.test.ts
corepack yarn build
env DATABASE_PATH=<private-temp>/runtime.db node dist/system/infrastructure/migrate.entry.js
corepack yarn eslint <all changed TypeScript files>
corepack yarn prettier --check <all changed TypeScript files>
git diff --check
```

All exited successfully.

A repository-wide baseline was attempted before implementation. The sandbox
rejects unrelated UNIX-domain socket/listener operations with `EPERM`; Quick
Tunnel, FFmpeg-runner, and setup-server suites failed or timed out, and the hung
run was interrupted. No repository-wide pass is claimed.

## Files

- `src/system/domain/ota-contracts.ts`
- `src/system/infrastructure/dual-slot-operation-journal.ts`
- `src/system/infrastructure/ota-updater.service.ts`
- `src/system/infrastructure/ota-updater.entry.ts`
- `src/system/infrastructure/migrate.entry.ts`
- `src/system/infrastructure/ota-discovery-config.loader.ts`
- `src/system/infrastructure/ota-lock-acquired-shim.ts`
- `package.json`
- `nest-cli.json`
- `test/fixtures/ota/contracts/schema-v1-vectors.json`
- focused and directly affected system tests
- `.superpowers/sdd/public-signed-ota-task-11-report.md`

The pre-existing untracked `scripts/__pycache__/` directory was not modified,
staged, or removed.

## Scope boundary

Task 10's privileged activator starts only the sandboxed preparation unit and
does not provision its required root-owned volatile receipt/projection. Task 11
therefore keeps preparation behind a direct port and keeps the executable main
fail-closed until installer-owned projection provisioning is supplied. Expanding
that privileged helper was deliberately not folded into this task because it
would change Task 10 assets outside the approved Task 11 plan. The injectable
entry runner and complete prepare-only state machine are present; no unsafe
unprivileged substitute was added.
