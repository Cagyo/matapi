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

Failed authorization cancels and parent-syncs the reservation. Publish failure
revokes the unused route. A crash can leave an authorized request that was
never published, but no updater process can start before the database route is
durable.

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
