# Task 3 — Feature readiness and published availability

## Outcome

Implemented the Task 3 readiness boundary, canonical availability projection,
list/detail projections, and the shared initial-verification boot gate. The
feature module wires the five fixed readiness adapters through one canonical
router and exports `FEATURE_AVAILABILITY` without importing Sensor, Camera, or
System modules.

## RED / GREEN evidence

RED was recorded before production implementation:

```text
5 focused suites failed to load the missing readiness, availability, list/detail,
boot-gate, and adapter modules.
```

GREEN after implementation:

```text
Test Files  6 passed (6)
Tests       15 passed (15)
yarn tsc --noEmit  # exit 0
```

The focused command was:

```text
yarn test test/features/application/verify-feature-readiness.use-case.test.ts \
  test/features/application/list-manageable-features.use-case.test.ts \
  test/features/application/get-feature-detail.use-case.test.ts \
  test/features/application/feature-readiness-boot.service.test.ts \
  test/features/infrastructure/feature-readiness.adapters.test.ts \
  test/features/application/list-features.use-case.test.ts
```

## Adapter safety

- Commands use fixed executable paths and fixed argument arrays, a sanitized
  PATH, a five-second timeout, and a 4 KiB output cap.
- Digital TCP, UART file/device, Motion file/media/group, and RTSP
  file-stat/group work are explicit injected seams. Adapter tests provide every
  seam; no host hardware, network, privilege, or service command is reached.
- Failures return only `application-verification-failed`. Logs contain only the
  canonical feature and a safe check label—not stdout, stderr, credentials, or
  deployment paths.
- The helper-version mismatch category was deliberately omitted from readiness;
  it is not persisted as `helper-update-required`.

## Gate semantics

`FeatureReadinessBootService` lazily creates one cached verification promise.
Bootstrap, `FeatureAvailabilityService.inspect`, `requireReady`, and the
published `awaitInitialVerification` all share it. Installed and enabled
manageable rows are verified independently in canonical order; a failed feature
is marked locally and logged without preventing other checks or startup.
Availability merges only the matching active install job with the feature row,
and `requireReady` rejects every not-installed, disabled, attention, or busy
state via `FeatureUnavailableError`.

## Task-owned files

- `src/features/domain/ports/feature-readiness.port.ts`
- `src/features/domain/ports/feature-availability.port.ts`
- `src/features/application/{verify-feature-readiness.use-case,feature-availability.service,feature-readiness-boot.service,list-manageable-features.use-case,get-feature-detail.use-case}.ts`
- `src/features/infrastructure/{in-memory-feature-readiness.adapter.ts,readiness/}`
- `src/features/feature.module.ts`, compatibility `list-features.use-case.ts`
- `test/features/application/*readiness*`, `list-manageable-features`,
  `get-feature-detail`, compatibility list test, and readiness-adapter tests
- `docs/ports-and-adapters.md`

## Concerns / follow-up

The exact RTSP installer artifacts are checked against the existing installer
layout. Task 7/8 must keep those paths, owner/mode contracts, and restart
reconciliation aligned if it replaces the installer boundary. Task 5/6 should
consume the published availability port and await the same gate before their
first feature effect.
