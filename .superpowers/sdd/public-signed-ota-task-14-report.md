# Public Signed OTA — Task 14 Report

## Outcome

Task 14 makes `/update` and `/rollback` exact-identity, receipt-authorized
Telegram workflows. `/update` passes the `CheckedReleaseIdentity` returned by
one signed-feed check directly into the launcher reservation; it does not
refetch or reconstruct remote identity. Public failures remain the closed
`OtaFailure` code catalog and Telegram never renders exception diagnostics.

The former git/shell OTA adapter, its lock/tag error types, and its dedicated
tests are removed. Real mode now binds `SignedFeedOtaAdapter`; stub mode binds a
non-mutating compatible facade.

## Reserve → authorize → publish

`FlockOtaOperationLauncherAdapter` now separates operation acceptance into:

1. `reserveUpdate` / `reserveRollback`: validate the exact request, atomically
   persist it, and return its receipt without spawning;
2. durable Telegram authorization: insert the exact operation ID, operation
   kind, user ID, private-chat ID, and workflow-return receipt ID only after the
   persisted receipt is still the correct running OTA workflow; and
3. `publish`: accept only that exact in-process reservation receipt and run the
   existing detached flock/receipt handshake.

Failed authorization cancels and parent-syncs the reservation. Once a route is
durable, publish rejection or failure retains it because the updater may have
become externally visible before the caller observed the failure. No updater
process can start before the database route is durable.

## Durable startup delivery

Generated migration `0006_late_drax.sql` adds
`ota_operation_workflows`, keyed by operation ID. Receipt IDs are deliberately
not globally unique: every lookup verifies the full user/chat/receipt owner and
the expected `ota-update` or `ota-rollback` running stage. Delivery uses a
durable singleton lease followed by delivered and acknowledged compare-and-set
markers.

The system context owns `StartupReportDeliveryService`; Telegram registers its
adapter before `SystemOnlineNotifier` invokes boot recovery. Exact-operation
reports are delivered only through the durable mapping and complete the exact
workflow receipt. Null-operation maintenance reports are localized and sent
only to current admins. Filesystem acknowledgement remains last, after mirror,
message/workflow completion, delivered CAS, and acknowledged CAS. Missing,
invalid, busy, or zero-recipient delivery retains the pending filesystem
report.

Legacy OTA branches were removed from `RestartConfirmationService`; ordinary
`/restart` and system-package update confirmation remain unchanged.

## TDD evidence

Initial launcher RED:

```text
Test Files  1 failed (1)
Tests       2 failed | 39 passed

reserveUpdate and reserveRollback were not functions.
```

Signed facade and workflow repository RED:

```text
SignedFeedOtaAdapter and DrizzleOtaOperationWorkflowRepository did not exist.
```

Final focused Task 14 GREEN:

```text
Test Files  12 passed (12)
Tests       72 passed (72)
```

Coverage includes no-spawn reservation, cancellation, exact checked identity,
authorization-before-publication ordering, authorization failure cleanup,
exact update and rollback handlers, full route validation, singleton delivery
leasing, failed-cleanup unpublishability, delivered/acknowledged CAS,
exact-chat startup delivery, localized
maintenance fan-out, filesystem acknowledgement ordering, registry behavior,
and removal of restart-confirmation OTA delivery.

Task 12/13 regression GREEN:

```text
Test Files  9 passed (9)
Tests       164 passed (164)
```

This includes recovery, startup-report consumption, installer contracts,
root activation authorization, activation, rollback, updater preparation,
dual-slot operation journal, and OTA contract suites.

## Verification

- `corepack yarn build` — exit `0`.
- Focused Task 14 suite — 12 files, 72/72 tests.
- Task 12/13 regression suite — 9 files, 164/164 tests.
- Targeted ESLint over changed Task 14 TypeScript — exit `0`.
- `git diff --check` — exit `0`.
- Exactly one generated migration exists: `migrations/0006_late_drax.sql`
  with its generated Drizzle snapshot/journal entries; no migration or metadata
  file was hand-edited.

The pre-existing untracked `scripts/__pycache__/` directory was not read,
modified, staged, or removed.

## Review hardening correction

Correction commit: `fix(telegram): harden OTA delivery`

The first Task 14 implementation still exported the raw operation-launcher
token and its adapters retained convenience `startUpdate` / `startRollback`
methods. Those methods performed reserve → publish without a workflow row.
The raw launcher is now internal to `SystemModule` and exposes reservation
transport only. The exported high-level OTA facade accepts an exact workflow
reference and performs reserve → durable binding → publish through a
system-owned, fail-closed binding registry registered by Telegram. Missing or
invalid references are rejected before reservation; absent registration or a
failed binding cancels the request without publication. Once binding succeeds,
publication rejection or crash retains the route.

Startup delivery now recognizes a terminal exact workflow receipt with a
delivery-proving stage as durable evidence after a crash between workflow
completion and route delivery CAS. After the lease expires, retry claims that
state, marks the route delivered, acknowledges it, and does not send again.
An already acknowledged route reports delivery without another effect, so the
outer startup-report consumer only removes the pending filesystem report.

The startup-report adapter no longer uses the lossy direct-message port. Its
dedicated confirmed port returns false without a live bot and propagates
Telegram rejection. Exact workflow completion receives that confirmed effect
through `WorkflowEntryCoordinator.completeHeadless`; exact route CAS does not
advance after an unconfirmed send. Null-operation maintenance fan-out counts
only confirmed sends, so zero confirmations retain the report.

Correction RED:

```text
Test Files  3 failed (3)
Tests       6 failed | 6 passed

Failures: direct-start/module-export bypass, completed-workflow invalid-route,
and startup delivery using the swallowing send boundary.
```

Correction focused GREEN:

```text
Test Files  15 passed (15)
Tests       84 passed (84)
```

Task 12/13 regression GREEN:

```text
Test Files  9 passed (9)
Tests       164 passed (164)
```

Final correction verification:

- `yarn build` — exit `0`.
- Targeted ESLint over every changed TypeScript file — exit `0`.
- `git diff --check` — exit `0`.
- Compiled `AppModule` Nest DI context in test/mock mode — `ok`.
- No schema or generated migration file changed in this correction.
- The pre-existing untracked `scripts/__pycache__/` remained untouched.

## Final compatibility correction

Correction commit: `fix(telegram): accept workflow receipts`

The system OTA facade initially validated workflow receipt IDs as 16 lowercase
hex characters. Workflow receipts are canonically 16-character unpadded
base64url values, so valid mixed-case IDs and IDs containing `_` or `-` were
rejected before reservation. The facade now uses the canonical
`[A-Za-z0-9_-]{16}` grammar and verifies that the value round-trips as exactly
12 base64url-decoded bytes.

Compatibility RED:

```text
Test Files  1 failed (1)
Tests       2 failed | 6 passed

Both update and rollback rejected real non-hex base64url workflow receipts.
```

Compatibility focused GREEN:

```text
Test Files  15 passed (15)
Tests       86 passed (86)
```

Final compatibility verification:

- `yarn build` — exit `0`.
- Targeted ESLint over the changed source and regression test — exit `0`.
- `git diff --check` — exit `0`.
- The pre-existing untracked `scripts/__pycache__/` remained untouched.
