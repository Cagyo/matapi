# Task 2 — Feature management persistence report

## Scope completed

- Added durable `attention_reason` storage for features.
- Added `feature_install_jobs` with foreign key, constrained statuses/scopes, and a nullable unique active slot.
- Added feature compare-and-set, verification, and attention repository operations in Drizzle and in memory.
- Added Drizzle and in-memory install-job repositories with queued creation, active lookup, running transition, terminal success/failure, and terminal history.
- Queued creation and both terminal transitions use immediate SQLite transactions. The unique active-slot error alone maps to `FeatureInstallBusyError`; unrelated SQLite failures propagate.

## RED evidence

Before production implementation, ran:

```sh
yarn test test/database/feature-management-migration.test.ts test/features/infrastructure/drizzle-feature-install-job.repository.test.ts
```

It failed as expected because the generated feature-management migration and `DrizzleFeatureInstallJobRepository` did not exist. The migration test reported `Generated feature-management migration was not found`; Vitest could not load the repository module.

An additional RED check confirmed the busy error initially identified the requested feature rather than the active feature. The assertion expected `activeFeature: 'motion'` and received `'uart'`; the adapter now reads the active row after the unique-slot violation.

## Migration generation and inspection

Generated with:

```sh
yarn db:generate
```

Generated migration: `migrations/0006_public_doctor_faustus.sql`.

Inspected with:

```sh
git diff -- src/database/schema.ts migrations
```

The final generated SQL is additive: it creates `feature_install_jobs`, its foreign key, three indexes (including the nullable unique active-slot index), three checks, and adds `features.attention_reason`. It contains no unrelated table rewrite.

The existing `features.enabled` / `installed` columns remain nullable in the Drizzle schema. Making them `NOT NULL` caused Drizzle to generate a rebuild that tried to select the new `attention_reason` from the pre-migration table, which would fail upgrading from `0000_init.sql`. That generated attempt was discarded; adapters normalize legacy `NULL` booleans to `false` at the repository boundary.

## GREEN evidence

```sh
yarn test test/database/feature-management-migration.test.ts test/features/infrastructure/drizzle-feature-install-job.repository.test.ts
```

Passed: 2 files, 8 tests — migration upgrade, active-slot collision/release in both terminal states, expected-state mismatch, running transition, terminal success, safe failure, and uncertain failure.

```sh
yarn tsc --noEmit
```

Passed with exit code 0.

## Scope deliberately deferred

No installer/readiness behavior, receipt delivery, Telegram UI, runtime gates, or module wiring was added. Those remain for their assigned tasks.

## Review follow-up

### Changed files

- `src/features/infrastructure/drizzle-feature.query.ts`
- `src/features/infrastructure/in-memory-feature-install-job.repository.ts`
- `test/features/infrastructure/drizzle-feature.query.test.ts`
- `test/features/infrastructure/in-memory-feature-install-job.repository.test.ts`

### RED evidence

Before the follow-up implementation, ran:

```sh
yarn test test/features/infrastructure/drizzle-feature.query.test.ts test/features/infrastructure/in-memory-feature-install-job.repository.test.ts
```

It failed as expected: `DrizzleFeatureQuery` returned `attentionReason: null` after the production feature repository wrote `partial-state-uncertain`; two simultaneous in-memory `createQueued` calls both fulfilled. The two terminalization tests also reached the pre-existing in-memory `markRunning` guard error (`Install job 'abcdefghijklmnop' is not active`), so that adapter transition was corrected as the necessary public-API precondition for exercising the reviewed terminalization paths.

### GREEN evidence

```sh
yarn test test/database/feature-management-migration.test.ts test/features/infrastructure/drizzle-feature-install-job.repository.test.ts test/features/infrastructure/drizzle-feature.query.test.ts test/features/infrastructure/in-memory-feature-install-job.repository.test.ts
```

Passed: 4 files, 12 tests. Coverage includes attention written/read through the production repository/query path, one global in-memory active slot under concurrent creation, and rollback plus continued active-job state when terminal success or safe-failure feature mutation cannot apply.

```sh
yarn tsc --noEmit
```

Passed with exit code 0.

### Concerns

The in-memory adapter serializes only its own state-changing calls; production durability and cross-process atomicity remain the responsibility of the existing immediate SQLite transactions. Feature rollback is limited to the repository port operations available here and deliberately does not introduce a broader transaction abstraction.

## Active-slot CHECK correction

### RED evidence

Before changing the schema, added the full-migration-chain regression and ran:

```sh
yarn test test/database/feature-management-migration.test.ts
```

It failed as expected: the new assertion that a queued job with `active_slot = NULL` throws a CHECK error instead received no error (`expected [Function] to throw an error`). This demonstrates SQLite's three-valued evaluation accepted the prior `active_slot = 1` predicate when the slot was NULL.

### Migration generation and inspection

Changed only `feature_install_jobs_active_slot_check` in `src/database/schema.ts` from `active_slot = 1` to the null-total SQLite predicate `active_slot IS 1`, then ran:

```sh
yarn db:generate
```

Drizzle generated `migrations/0007_flashy_golden_guardian.sql` and its journal/snapshot metadata. The required SQLite table rebuild copies all 13 existing `feature_install_jobs` columns, retains the feature foreign key and all three named CHECK constraints, then recreates the nullable unique active-slot index plus the feature/time and receipt indexes. The migration test applies the full ordered chain and separately proves a pre-0007 queued job survives the rebuild with a clean `foreign_key_check` result.

### GREEN evidence

```sh
yarn test test/database/feature-management-migration.test.ts test/features/infrastructure/drizzle-feature-install-job.repository.test.ts
```

Passed: 2 files, 10 tests. This includes queued and running NULL-slot rejection after the full migration chain, valid pre-existing job preservation through the rebuild, the active-slot uniqueness/release behavior, and repository persistence behavior.

```sh
yarn tsc --noEmit
git diff --check
```

Both passed with exit code 0.

### Files

- `src/database/schema.ts`
- `migrations/0007_flashy_golden_guardian.sql` (generated)
- `migrations/meta/_journal.json` (generated)
- `migrations/meta/0007_snapshot.json` (generated)
- `test/database/feature-management-migration.test.ts`

### Concern

The stricter rebuilt table intentionally cannot copy a pre-existing corrupt queued/running row whose `active_slot` is NULL; SQLite will stop the migration rather than silently reclassify or discard that job. Valid pre-0007 job data is preserved and verified. Repairing corrupt historical jobs would require an explicit data-repair policy, which is outside this narrowly approved schema-invariant correction.

## Final review follow-up: in-memory running transition

### RED evidence

Added a regression covering a repeated `markRunning()` call with a later timestamp, then ran:

```sh
yarn vitest run test/features/infrastructure/in-memory-feature-install-job.repository.test.ts
```

It failed as expected: the repeated call resolved with the job still `running` and changed `updatedAt` to the later timestamp (`2030-01-02T03:06:05.000Z`) instead of rejecting.

### GREEN evidence

`markRunning()` now accepts only an active queued job, matching the production Drizzle transition's `WHERE status = 'queued'` condition. The repeated call rejects and leaves the persisted `updatedAt` at the first running timestamp.

```sh
yarn vitest run test/features/infrastructure/in-memory-feature-install-job.repository.test.ts
```

Passed: 1 file, 4 tests.

```sh
yarn test test/database/feature-management-migration.test.ts test/features/infrastructure/drizzle-feature-install-job.repository.test.ts test/features/infrastructure/drizzle-feature.query.test.ts test/features/infrastructure/in-memory-feature-install-job.repository.test.ts
yarn tsc --noEmit
git diff --check
```

Passed: persistence suite 4 files, 15 tests; TypeScript check and whitespace check both exited with code 0.
