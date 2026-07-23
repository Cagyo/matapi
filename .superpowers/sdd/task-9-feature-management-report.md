# Task 9 — Feature-management deployment report

Implemented at base `04021bc`.

## Delivered

- First/root install atomically deploys the fixed root bundle under `/usr/lib/home-worker`, including the helper, routines, feature units, and RTSP stream executable/unit/rule templates.
- The helper validates the root-owned version and exact manifest before running a routine; a validated claimed job receives `helper-version-mismatch` when that boundary is stale.
- The unprivileged OTA updater performs only root-bundle validation and stops with `helper-update-required`; it does not install, move, chown, or reload root assets.
- Request/result spools use `root:homeworker 0770`; claims remain root-only `0700`.
- First-install feature state is rewritten atomically from only successful fixed-routine, privileged, and application-visible verification results.
- The setup wizard and server accept only `digital`, `uart`, `zigbee`, `motion`, and `rtsp`.
- Feature seeding is now port-based. The application layer consumes a bounded strict selection adapter plus query/repository ports, and only a verified first-install list is marked installed/enabled.

## Verification

Passed:

`yarn test test/system/infrastructure/motion-install-script.test.ts test/system/infrastructure/update-script.test.ts test/system/infrastructure/feature-install-deployment.test.ts test/system/infrastructure/feature-installer-script.test.ts test/features/application/feature-seeder.service.test.ts test/features/infrastructure/fs-feature-seed-config.adapter.test.ts test/features/infrastructure/feature-install-spool.adapters.test.ts test/setup-wizard`

Result: 9 files / 43 tests passed.

Also passed: `yarn build` and `git diff --check`.

## Outstanding

- No SSH or Raspberry Pi deployment was performed.
- A release that changes the helper bundle version requires a local trusted root run of `scripts/install.sh` before an OTA update can continue; this is intentional fail-closed behavior.

## Review follow-up

- The privileged RTSP routine now skips copying root-bundle executables when source and destination are identical; an executable mocked-command test covers policy and unit activation.
- Git, local-source, and release-tarball updates validate the candidate helper version before mutating the installed application. This preserves the old checkout after a helper mismatch, so a trusted helper deployment followed by retry can complete normally.
