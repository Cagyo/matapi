# Task 1 — Manageable feature domain report

## Scope delivered

- Added the manageable-feature names, install wire contracts, strict result parser, install-job types, and active-job type.
- Replaced the catalog with five supported, locale-keyed entries and validates names, description keys, duplicates, and optional enabled defaults at module initialization.
- Added attention-aware feature status derivation. Local guidance reasons (`inconsistent-state`, `restart-required`, and `helper-update-required`) have no action; verifiable damage retains `verify`.
- Added six typed domain errors with stable codes and non-sensitive messages.
- Updated the existing list test for the locale-keyed `zigbee` catalog entry.

## RED evidence

Command:

```text
yarn test test/features/domain/manageable-feature.test.ts
```

Result: exit 1. Vitest could not load `../../../src/features/domain/manageable-feature`; the file did not yet exist. The suite contained zero collected tests, which is the expected missing-production-module failure for the newly written tests.

## GREEN evidence

Command:

```text
yarn test test/features/domain/manageable-feature.test.ts test/features/application/list-features.use-case.test.ts
```

Result: exit 0.

```text
Test Files  2 passed (2)
Tests       19 passed (19)
```

`git diff --check -- config/feature-catalog.json src/features/domain test/features/domain test/features/application/list-features.use-case.test.ts` also exited 0.

## Files changed

- `config/feature-catalog.json`
- `src/features/domain/manageable-feature.ts`
- `src/features/domain/feature.entity.ts`
- `src/features/domain/feature-status.ts`
- `src/features/domain/feature-catalog.ts`
- `src/features/domain/errors/feature-unavailable.error.ts`
- `src/features/domain/errors/feature-inconsistent.error.ts`
- `src/features/domain/errors/feature-install-busy.error.ts`
- `src/features/domain/errors/feature-state-changed.error.ts`
- `src/features/domain/errors/feature-verification.error.ts`
- `src/features/domain/errors/feature-restart-dispatch.error.ts`
- `test/features/domain/manageable-feature.test.ts`
- `test/features/application/list-features.use-case.test.ts`

## Self-review and concerns

- The strict parser rejects unknown or missing fields, invalid identity, non-string job IDs, invalid enum values, oversized payloads, unsafe failure codes, and inconsistent success acknowledgements (success now requires `privilegedReady: true` plus a non-null restart scope).
- `yarn tsc --noEmit` currently exits 2 because downstream Task 2 / persistence boundaries are not yet updated for the intentionally expanded `Feature` and `FeatureStatus` contracts. Exact failures are in `src/features/application/list-features.use-case.ts`, `src/features/infrastructure/drizzle-feature.query.ts`, and `src/features/infrastructure/drizzle-feature.repository.ts`; these are outside Task 1 ownership and were not modified.

## Task 1 review-fix follow-up

### Detailed fix

- Reworked `ListFeaturesUseCase` to map each catalogue entry through the pure `deriveFeatureStatus` function with no active job. It now returns the current `FeatureStatus` shape and no longer produces localized description data.
- Retained an unused optional description resolver parameter temporarily so the existing Telegram caller remains source-compatible during the parallel migration; it is not invoked and no description is returned.
- Made both Drizzle `Feature` mappers explicitly return `attentionReason: null` until Task 2 adds persistence for that field.
- Updated the focused use-case test to assert status state, readiness, display, and action, and to remove obsolete locale-description expectations.

### RED evidence

Command:

```text
yarn tsc --noEmit
```

Result: exit 2 with exactly the expected three errors: the list use case omitted `ready`, `busy`, `attentionReason`, `display`, and `action`; both Drizzle mappers omitted `Feature.attentionReason`.

Focused regression test RED command:

```text
yarn test test/features/application/list-features.use-case.test.ts
```

Result: exit 1, 2 failed assertions because the old objects lacked the derived status fields and still exposed `description`.

### GREEN evidence

Command:

```text
yarn tsc --noEmit && yarn test test/features/domain/manageable-feature.test.ts test/features/application/list-features.use-case.test.ts
```

Result: exit 0. TypeScript reported no errors; Vitest reported 2 files passed and 18 tests passed.

### Files changed in this follow-up

- `src/features/application/list-features.use-case.ts`
- `src/features/infrastructure/drizzle-feature.query.ts`
- `src/features/infrastructure/drizzle-feature.repository.ts`
- `test/features/application/list-features.use-case.test.ts`

### Follow-up concern

- `attentionReason` is intentionally not persisted yet; the two production adapters map it to `null` until Task 2 owns the schema and durable storage work.

## Task 1 boundary review fix

### Detailed fix

- Removed `FeatureDescriptionResolver` and `featureDescription` from the feature domain catalogue. Catalogue entries retain a locale key as data only; resolving localized presentation text is no longer a domain concern.
- Removed the obsolete optional resolver argument from `ListFeaturesUseCase.execute`.
- Updated the Telegram feature handler to invoke the list use case with no resolver. Its existing list rendering with `en.feature.listLine` is unchanged pending Task 11.
- Added a focused domain boundary regression test asserting that the catalogue module does not export the presentation resolver function.

### RED evidence

Command:

```text
yarn test test/features/domain/feature-catalog.test.ts
```

Result: exit 1, as expected before the production change.

```text
Test Files  1 failed (1)
Tests       1 failed (1)
AssertionError: expected ... to not have property "featureDescription"
Received: [Function featureDescription]
```

### GREEN evidence

Command:

```text
yarn tsc --noEmit && yarn test test/features/domain/feature-catalog.test.ts test/features/domain/manageable-feature.test.ts test/features/application/list-features.use-case.test.ts && git diff --check -- src/features/domain/feature-catalog.ts src/features/application/list-features.use-case.ts src/telegram/interfaces/feature.handler.ts test/features/domain/feature-catalog.test.ts
```

Result: exit 0.

```text
Test Files  3 passed (3)
Tests       19 passed (19)
```

### Files changed in this boundary fix

- `src/features/domain/feature-catalog.ts`
- `src/features/application/list-features.use-case.ts`
- `src/telegram/interfaces/feature.handler.ts`
- `test/features/domain/feature-catalog.test.ts`
- `.superpowers/sdd/task-1-report.md`

### Concerns

- The list handler continues to use existing English rendering; Task 11 remains responsible for replacing that presentation behavior with the intended localized interface flow.
