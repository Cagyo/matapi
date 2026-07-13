# Live Camera Final Fix Wave Report

Date: 2026-07-13

## Outcome

Implemented the five final-review fixes as one consolidated wave:

1. Setup now derives `LIVE_STREAM_ENABLED` from the explicit `rtsp` selection while writing `features.json` from the same feature key.
2. The `rtsp` installer configures Cloudflare's signed apt key/repository idempotently on `amd64`, `i386`, `armhf`, and `arm64`, retains the shared apt-lock timeout, and never installs a persistent service or changes user configuration.
3. The authoritative five-minute monotonic session starts only after Quick Tunnel readiness succeeds.
4. Explicit process shutdown tears live streaming down before `app.close()` while Telegram cleanup is registered; `OnModuleDestroy` reuses the same memoized bounded teardown.
5. Grants and message references are bounded to one per Telegram user and the configured global viewer cap; replacement revokes the old grant and best-effort deletes the old message.

## RED / GREEN evidence

### Setup runtime gate

- RED: `yarn test test/setup-wizard/env-writer.test.ts`
  - Result: 1 failed / 4 tests; selected `rtsp` still produced `LIVE_STREAM_ENABLED=false`.
- GREEN: `yarn test test/setup-wizard/env-writer.test.ts test/features/application/feature-seeder.service.test.ts`
  - Result: 2 files passed / 8 tests passed.

### Signed Cloudflare apt source

- RED: `yarn test test/system/infrastructure/live-stream-install-script.test.ts`
  - Result: 2 failed / 9 tests; no signing key/source was created and unsupported `riscv64` was accepted.
- Portability correction exposed by GREEN attempt: macOS test stubs rejected GNU `mkdir --mode`, and the existing diagnostic harness had no `dpkg`; production behavior was retained through portable directory mode-setting and an explicit test-only Debian-architecture override.
- GREEN: `yarn test test/system/infrastructure/live-stream-install-script.test.ts test/system/infrastructure/apt-locking-script.test.ts && bash -n scripts/install-feature.sh`
  - Result: 2 files passed / 12 tests passed; shell syntax exited 0.

### Deadline after readiness

- RED: `yarn test test/camera/application/live-stream-session.service.test.ts -t "starts the full session deadline"`
  - Result: 1 failed; delayed readiness returned 25 ms remaining and expiry 1100 instead of 100 ms and 1175.
- GREEN: same command.
  - Result: 1 passed; expiry occurs exactly one duration after readiness.

### Bounded grants and references

- RED: `yarn test test/camera/application/live-stream-session.service.test.ts -t "replaces a user grant|rejects a third distinct|one hundred opens"`
  - Result: 3 failed; no old-token revocation, third user admitted, and 100 opens retained unbounded state.
- Self-review RED: `yarn test test/camera/application/live-stream-session.service.test.ts -t "releases a revoked user message slot"`
  - Result: 1 failed; a revoked user's message reference remained and allowed three retained references.
- GREEN: `yarn test test/camera/application/live-stream-session.service.test.ts`
  - Result: 1 file passed / 51 tests passed.
- Lease/handler seam GREEN: `yarn test test/camera/application/live-stream-session.service.test.ts test/camera/infrastructure/fs-live-stream-lease.adapter.test.ts test/telegram/interfaces/camera.handler.test.ts test/telegram/infrastructure/telegram-live-stream-message-cleanup.adapter.test.ts`
  - Result before the final added regressions: 4 files passed / 78 tests passed.

### Graceful shutdown

- RED: `yarn test test/camera/application/live-stream-session.service.test.ts -t "explicit and module shutdown|contains teardown errors" test/system/application/prepare-application-shutdown.test.ts`
  - Result: 3 failures; `shutdown`, `onModuleDestroy`, and the ordered composition function did not exist.
- GREEN: `yarn test test/camera/application/live-stream-session.service.test.ts test/system/application/prepare-application-shutdown.test.ts`
  - Result after timeout/fallback regression was added: 2 files passed / 51 tests passed.
- Ordering GREEN: `yarn test test/system/application/prepare-application-shutdown.test.ts test/system/infrastructure/process-shutdown.gateway.test.ts test/system/application/graceful-shutdown.service.test.ts`
  - Result: 3 files passed / 9 tests passed.

## Final verification

- Combined scope (camera, setup, seeding, installer/apt, shutdown, Telegram handler/cleanup):
  - Command: `yarn test test/camera test/setup-wizard test/features/application/feature-seeder.service.test.ts test/system/application/graceful-shutdown.service.test.ts test/system/application/prepare-application-shutdown.test.ts test/system/infrastructure/process-shutdown.gateway.test.ts test/system/infrastructure/live-stream-install-script.test.ts test/system/infrastructure/apt-locking-script.test.ts test/telegram/interfaces/camera.handler.test.ts test/telegram/infrastructure/telegram-live-stream-message-cleanup.adapter.test.ts`
  - Sandboxed run: setup server loopback binds timed out as expected under restricted sockets.
  - Scoped-loopback run: 41 files passed / 292 tests passed.
- Targeted ESLint:
  - Command: `yarn eslint src/camera/application/live-stream-session.service.ts src/camera/camera.module.ts src/camera/domain/live-stream.entity.ts src/camera/infrastructure/fs-live-stream-lease.adapter.ts src/main.ts src/prepare-application-shutdown.ts test/camera/application/live-stream-session.service.test.ts test/camera/infrastructure/fs-live-stream-lease.adapter.test.ts test/setup-wizard/env-writer.test.ts test/system/application/prepare-application-shutdown.test.ts test/system/infrastructure/live-stream-install-script.test.ts`
  - Result: exit 0, no findings.
- Shell syntax: `bash -n scripts/install-feature.sh scripts/install.sh`
  - Result: exit 0.
- Build: `yarn build`
  - Result: exit 0.
- Full regression with scoped loopback permission: `yarn test`
  - Result: 167 files passed / 1004 tests passed.
- Whitespace: `git diff --check`
  - Result: exit 0.

## Self-review

- The setup writer, not the feature installer, exclusively owns `.env` runtime opt-in mutation.
- Apt signature verification remains enabled through `signed-by`; there is no `trusted=yes`, `--allow-unauthenticated`, curl-pipe-shell, Cloudflare service install, or persistent Cloudflare config mutation.
- The gateway still receives a clearly named provisional session during readiness; only the post-readiness session is leased, exposed, and timed.
- Shutdown is rooted in the application composition layer, avoiding CameraModule/SystemModule/TelegramModule cycles. The memoized fallback cannot double-stop or double-clear after explicit preparation.
- Grant capacity never evicts an existing user. Same-user replacement revokes the prior gateway hash before issuing the replacement. Revocation also frees and cleans the user's retained message slot.
- Lease validation now requires the Telegram owner on every message reference; legacy/invalid leases fail closed into existing sanitized recovery behavior.
- Unrelated dirty task reports and untracked plan files were not edited, staged, or committed.

## Manual acceptance

**PENDING.** No Raspberry Pi, Motion daemon, real Cloudflare tunnel, Telegram iOS/Android client, reboot recovery, or resource measurement was available. No hardware result was fabricated; every real-device item remains PENDING in `docs/compatibility/live-camera-mjpeg.md`.

## Commit

- Command: `git commit -m "fix(camera): close live stream production gaps"`
- Scope: only the final-fix implementation, tests, compatibility automated counts, and this report.
