# Public Signed OTA — Task 13 Report

## Outcome

Task 13 adds installer-owned recovery before PM2 resurrection. The isolated
`home-worker-ota-recover.service` runs as `homeworker` with no network access,
strict filesystem protection, and a root-installed launcher. It validates the
service-owned dual-slot journal and local pointers, then requests only one of
two fixed root-helper actions using the operation ID. The root helper ignores
caller-supplied paths or targets and independently revalidates the journal,
pointers, release tree, signed envelope, known-good marker, trust keys, and the
persistent root policy before changing links or finalizing the journal.

An `activated` operation is finalized without another readiness wait only when
`current` is the candidate, `previous` is the recorded prior current, and the
candidate has the same-operation durable known-good marker. Other interrupted
activations restore the recorded prior links after the prior release is
cryptographically revalidated. Missing journals are a no-op; corrupt or
conflicting state writes a durable null-identity maintenance report before the
required recovery unit fails and keeps PM2 stopped.

## Persistent policy correction

The root authorization policy now lives at the literal
`/etc/home-worker/ota-policy.json`. The authenticated installer derives and
strictly validates the stable feed, target/runtime tuple, and bounded limits,
then writes a canonical schema-v1 checksummed document using file sync, atomic
rename, and parent-directory sync. Loading requires a root:root regular,
non-symlink, non-group/world-writable file. There is no environment override,
and the service-owned `/run` operation projection contains only operation
binding data, not policy or remote identity authority.

Recovery reuses that persistent policy. Trust keys remain fixed under
`/etc/home-worker/update-keys`; the policy contains no operation, candidate,
key, or remotely signed identifiers.

## Startup report handoff

`StartupReport` permits all-null identity fields only for
`maintenance-required`, so corrupt-state recovery and TypeScript agree on one
strict contract. Reports are file-synced and atomically renamed before the
recovery unit stops. Application startup performs the idempotent sequence
read → parse → mirror to `system_meta` → deliver → atomic acknowledge. Delivery
errors retain the pending report for retry, and a zero-recipient result also
does not acknowledge it, allowing Task 14 to add concrete recipients without
losing recovery outcomes.

## TDD evidence

Initial RED:

```text
Test Files  3 failed (3)

- installer/ota-recover.mjs missing
- ConsumeStartupReportUseCase missing
- null maintenance identity rejected by StartupReport parser
```

Root-helper boundary RED:

```text
Test Files  1 failed (1)
Tests       1 failed | 20 passed

recoverOperation was not exported.
```

Final focused GREEN:

```text
Test Files  8 passed (8)
Tests       124 passed (124)
```

Coverage includes same-operation post-health finalization without readiness,
normal link restoration, corrupt dual-slot stop with a null maintenance report,
fixed action/target rejection, persistent-policy load/absence/permission and
symlink checks, no-journal versus corrupt-journal behavior, delivery crash and
retry, zero-recipient retention, and the Task 12 activation/journal regressions.

## Verification

- `corepack yarn build` — exit `0`.
- Focused Task 13 plus Task 12 regression suite — 8 files, 124/124 tests.
- Targeted ESLint over changed TypeScript — exit `0`.
- Targeted Prettier check — exit `0`.
- `node --check` for all three installer helpers — exit `0`.
- `bash -n scripts/install.sh` — exit `0`.
- `git diff --check` — exit `0`.

The full repository suite was also attempted. It is not a valid sandbox-wide
signal here: unrelated camera, setup-wizard, and FFmpeg-runner tests failed to
bind Unix sockets with `EPERM`, followed by their expected timeout cascades.
The focused OTA suites remained green in that run and in the clean rerun above.

The pre-existing untracked `scripts/__pycache__/` directory was not read,
modified, staged, or removed.

## Re-review correction: exhaustive fail-closed recovery

Correction commit: `fix(ota): fail closed recovery states`

The first recovery coordinator handled `activating`, `activated`, and
`healthy` with independent conditionals. Legal terminal or preparatory phases
could therefore reach the end of the function without a report, a root action,
or a stop request. In particular, `rollback_failed` allowed the required
pre-PM2 unit to succeed after an explicitly failed rollback.

Recovery now uses an exhaustive schema-v1 phase matrix:

- `activated` finalizes only with exact root-pointer state and a matching
  operation, tree, artifact, and metadata known-good identity;
- `activating` and an uncommitted `activated` state durably record failure
  before requesting the fixed root restore action;
- `healthy` reports success only with the same complete commit proof;
- `rolled_back` requires exact restored pointers and a prior known-good marker,
  then invokes the root restore action idempotently for full signed-policy
  revalidation; and
- `preparing`, `prepared`, `failed_pre_activation`, `rollback_failed`, and
  `cleanup_pending` write a null-identity maintenance report before requesting
  stop. No valid phase can silently fall through.

The root restore action accepts `rolled_back` only as an idempotent state. It
revalidates the prior release against its signed envelope, known-good marker,
trust keys, persistent policy, and exact pointers, but does not repeat the
terminal journal transition.

Correction RED:

```text
Test Files  1 failed (1)
Tests       13 failed | 4 passed

Failures covered silent legal-phase fallthrough, healthy pointer/marker
conflicts, report-after-restore ordering, and non-idempotent rolled-back boot.
```

The stricter activated-conflict regression then failed 3/22 cases before the
matrix distinguished an absent known-good marker (safe restoration) from a
present stale marker or conflicting root pointer (maintenance stop). A final
unreadable-marker regression failed 1/23 before corrupt marker reads were kept
distinct from a genuinely absent marker.

Correction GREEN and verification:

```text
Test Files  9 passed (9)
Tests       156 passed (156)
```

The correction suite includes Task 13 recovery/consumption/policy tests plus
the Task 12 root-helper, activation, and dual-slot journal regressions.
