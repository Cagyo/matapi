# Task 15 Report — Remove legacy Drive utility integration and verify release readiness

Status: **DONE_WITH_CONCERNS**

## Outcome

- Removed the repository-owned legacy Drive utility ports, adapters, stubs, health metadata, use cases, scheduler, commands, tests, installer/configuration paths, and active-documentation references.
- Kept the Camera-to-Archive integration on application ports: completed videos register archive artifacts, local cleanup requires current exact-ID verification, manual remote cleanup delegates to `ApplyDriveRetentionUseCase`, and the shared remote-mutation lock still prevents overlapping cleanup.
- Wired `ARCHIVE_CLOCK` and `ApplyDriveRetentionUseCase` into Archive composition. Scheduled maintenance reconciles first and then applies retention. An unhealthy clock remains fail-closed for deletion, emits the sanitized `clock-unhealthy` administrator alert, and no longer prevents worker startup.
- Added bounded archive scheduler defaults and environment overrides for interval, lease duration, and newer-video batch size.
- Updated install/update/system-dependency behavior for the direct Google API implementation and Node.js 22.
- Hardened installation state provisioning: `/etc/home-worker` is `root:homeworker` mode `0750`; the archive key is exactly 32 random bytes and the installation ID is canonical UUID text; both are atomically published only when absent, validated as regular non-symlink single-link files with exact owner/group/mode, and never silently replaced.
- Added an executable removal fence and a disposable-account/on-device smoke procedure at `test/archive/google-drive-live-smoke.md`.

## Removed seams

- Camera domain: legacy Drive auth/status/sync/health ports and Drive-specific legacy errors.
- Camera application: legacy authorization, status, upload, remote cleanup, and Drive scheduler use cases/services.
- Camera infrastructure: legacy command adapters, stubs, and metadata/in-memory sync-health adapters.
- System/install/update: legacy utility package checks, config creation, feature installation, self-update, and sudoers paths.
- Telegram/locales/tests: obsolete authorization command wiring/copy and legacy-focused test suites.

## Retained replacement seams and safety contracts

- `ARCHIVE_REGISTRATION` and `ARCHIVE_VERIFICATION` remain the only Camera-facing archive seams.
- `ApplyDriveRetentionUseCase` performs bounded exact-ID deletion only after healthy-clock, active-generation, ownership, immutable-attempt, source, quota, and immediate remote-object revalidation checks.
- `ArchiveRemoteMutationLockService` remains shared by upload, reconciliation, verification, retention, and Camera cleanup coordination.
- Local cleanup never requests remote deletion and requires a current verified attempt for the active generation.
- Installer behavior does not uninstall a host utility, inspect/delete user configuration, revoke old credentials, or inspect/delete any pre-existing remote content.

## Documentation updated

Active top-level, architecture, port, testing, migration, installation, OTA, health, bot, database, reliability, and Drive/archive specifications now describe the `archive` context, OAuth device authorization, immutable attempts, consistent SQLite backups, resumable uploads, exact-ID safety, retention, external key semantics, and Node.js 22. Historical dated plan/design documents under `docs/superpowers/` were intentionally preserved.

## Verification evidence

### Passing

- Red phase: the new removal/configuration/composition tests failed while legacy files and missing retention/scheduler wiring remained.
- Task-owned suite: **10 files, 64 tests passed**.
- `yarn build`: **passed**.
- Task-owned ESLint invocation: **passed with zero findings**.
- `yarn db:generate`: **`No schema changes, nothing to migrate`**.
- `git status --short migrations src/database/schema.ts`: **clean**.
- Active-reference scan for the removed utility name and its old environment prefixes across package/config/scripts/source/tests/docs: **no output** (historical dated plans/specs excluded exactly as required).
- `git diff --check` across Task 15 paths: **passed**.

### Repository-wide concerns outside Task 15

- `yarn test`: **307/314 files passed; 2,295/2,340 tests passed**. The 45 failures are confined to seven non-Task-15 failure groups:
  - 8 Unix-socket sandbox failures in `quick-tunnel-rtsp-live-stream.adapter.test.ts`;
  - 16 loopback-listener sandbox failures/timeouts in `quick-tunnel-live-stream.adapter.test.ts`;
  - 7 loopback-listener sandbox timeouts in `setup-wizard/server.test.ts`;
  - 6 Unix-socket sandbox failures in `live-stream-ffmpeg-runner.test.ts`;
  - 3 install-harness failures because the host lacks `free` and denies `/swapfile` creation;
  - 3 grammY fixture failures caused by the concurrent `archiveAdminAlerts` constructor seam;
  - 2 application-smoke failures caused by concurrent feature-readiness behavior.
- `yarn lint`: **28 errors outside Task 15-owned files**. A direct ESLint run over all Task 15 TypeScript files passes.

## Live release matrix

The operator procedure and evidence table are present in `test/archive/google-drive-live-smoke.md`, but were **not run** in this environment. No supported Raspberry Pi hardware/OS matrix or disposable Google account was provided, and the task explicitly forbids inventing live results or mutating host/Google state. Release still requires recording Node 22, native `better-sqlite3` install/backup, peak RSS below 512 MiB, upload/resume behavior, and unrelated Drive/Trash safety on every supported Pi OS/architecture combination.

## Commit

Subject: `refactor(archive): remove rclone integration`
