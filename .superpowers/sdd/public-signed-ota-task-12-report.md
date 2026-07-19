# Public Signed OTA — Task 12 Report

## Outcome

Task 12 activation and rollback landed in `9a117af feat(ota): activate and roll
back releases`. The root-owned helper validates the durable prepared operation,
adopts and revalidates the candidate, runs its fixed migration entrypoint,
atomically switches `current`, starts the fixed PM2 definition, requires
operation-bound readiness from one stable process, records known-good state,
commits `previous`, and only then journals `healthy`. Local rollback uses the
same activation and health path.

The follow-up `fix(ota): harden release activation` closes the activation-only
security findings without adding Task 13 recovery, cleanup, or notification
work.

## Security hardening

- The root helper independently parses the strict schema-v1 signed envelope,
  derives Ed25519 key IDs from root-controlled PEM keys, and verifies signatures
  over the exact payload bytes. Updates require an active key, fresh metadata,
  and an exact match with both `artifact-state.json` and the durable journal
  identity. Rollback accepts active or retired keys only for an exact local
  known-good artifact/tree identity and intentionally ignores remote expiry.
- Candidate adoption no longer trusts ownership changes on the staged inodes.
  The helper quarantines and removes service write access from the staged tree,
  streams regular files through no-follow handles into a new root-owned tree,
  preserves symlinks without following them, normalizes final modes to `0644`
  or `0755`, fsyncs the projection, verifies the prepared-tree digest, atomically
  installs it, and verifies the digest again. Retained descriptors refer only to
  the quarantined inodes, which are removed after successful adoption.
- PM2's old process definition is stopped and deleted before the fixed process
  definition is started. The first observation must be online with restart count
  exactly zero; any later PID or restart-counter change fails health.
- `healthy` is now the final durable commit after readiness, known-good fsync,
  and atomic/fsynced `previous`. Failure before the `previous` commit restores
  both prior pointers and journals `rolled_back`. Failure to persist `healthy`
  after `previous` committed preserves the candidate/current/previous state,
  leaves the operation `activated`, and reports `maintenance-required` for the
  later recovery task rather than creating pointer/journal split-brain.

The root-owned operation projection remains deliberately fail-closed because
its producer belongs to the later recovery/orchestration slice.

## TDD evidence

Initial hardening RED:

```text
Test Files  1 failed | 1 passed (2)
Tests       4 failed | 20 passed (24)

Failures: missing root signature verifier; previous after healthy; PM2 process
definition retained; initial restart counter accepted.
```

Final focused activation GREEN:

```text
Test Files  2 passed (2)
Tests       28 passed (28)
```

Added regressions cover active-key update authorization, unknown-key rejection,
retired-key rollback-only authorization, mutation through a retained writable
file descriptor after adoption, nonzero initial PM2 restart count, failure to
commit `previous`, and failure to persist `healthy` after `previous` committed.

## Verification

```text
corepack yarn test \
  test/system/domain/ota-contracts.test.ts \
  test/system/domain/prepared-tree.test.ts \
  test/system/domain/signed-manifest.test.ts \
  test/system/infrastructure/dual-slot-operation-journal.test.ts \
  test/system/infrastructure/ed25519-keyring.loader.test.ts \
  test/system/infrastructure/prepared-tree.gateway.test.ts \
  test/system/infrastructure/ota-activation.test.ts \
  test/system/infrastructure/ota-rollback.test.ts \
  test/system/infrastructure/readiness-marker.adapter.test.ts \
  test/system/infrastructure/rollback-script.test.ts \
  test/system/infrastructure/ota-activate-helper.test.ts \
  test/system/infrastructure/ota-updater-preparation.test.ts
```

Result: 12 files passed, 231/231 tests passed.

- `corepack yarn build` — exit `0`.
- Targeted ESLint over the changed TypeScript files — exit `0`.
- `node --check installer/ota-activate.mjs` — exit `0`.
- Targeted Prettier check — exit `0`.
- `git diff --check` — exit `0`.

The pre-existing untracked `scripts/__pycache__/` directory was not read,
modified, staged, or removed.

## Re-review correction: canonical root release policy

Correction commit: `fix(ota): enforce root release policy`

The first hardening pass cryptographically verified the exact signed payload
and journal identity, but its local root parser did not independently apply the
canonical `ManifestPolicy`. A valid publisher signature plus a matching journal
could therefore authorize a release for another supported architecture or ABI,
a libc minimum newer than the device, an artifact on another HTTPS origin, or
resource declarations above the configured ceilings.

The root-owned operation projection now carries the canonical policy authority.
The activation helper validates its exact closed shape and compiled hard maxima,
including the stable feed path for the one configured target. Before comparing
the manifest with journal identity, root authorization independently requires:

- the exact configured Linux ARM/ARM64 and glibc target mapping;
- the exact Node modules ABI and a canonical signed libc minimum no newer than
  the configured runtime libc;
- a credential-free HTTPS feed URL at the fixed stable target path and an
  artifact URL on that exact allowed origin;
- the configured artifact, expanded, prepared-byte, prepared-file, and file
  ceilings, each itself bounded by its compiled hard maximum; and
- the existing stable channel, Node 20, and `yarn@4.13.0` runtime constraints.

The regression uses correctly signed envelopes whose malicious identities are
also copied into the marker and journal, proving journal agreement cannot stand
in for policy authorization. It covers a different target architecture, an
unauthorized artifact origin, Node ABI mismatch, incompatible libc minimum, and
an artifact declaration one byte above the configured ceiling.

Correction RED:

```text
Test Files  1 failed (1)
Tests       5 failed | 15 passed (20)

All five correctly signed, marker-matched, and journal-matched policy violations
resolved instead of rejecting.
```

Correction GREEN and verification:

```text
corepack yarn test test/system/infrastructure/ota-activate-helper.test.ts \
  test/system/infrastructure/ota-activation.test.ts

Test Files  2 passed (2)
Tests       33 passed (33)
```

`corepack yarn build`, targeted ESLint, `node --check`, targeted Prettier, and
`git diff --check` all exited successfully. The pre-existing untracked
`scripts/__pycache__/` directory remained untouched.

The final policy-equivalence regression run also included the canonical signed
manifest and discovery-config policy suites: 4 files passed, 142/142 tests.
