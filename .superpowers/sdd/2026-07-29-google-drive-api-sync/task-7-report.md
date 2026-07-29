# Task 7 — Telegram OAuth setup evidence

## Scope delivered

- Added receipt- and generation-bound Google Drive connect, confirmation, cancellation, and disconnect use cases.
- Added an asynchronous device-code polling service and outcome port. Device codes remain service-memory-only; staged material is purged on service initialization after a restart.
- Added strict installed-client JSON validation: a single top-level `installed` object, an allowlisted key set, and validated client ID/secret. Uploaded endpoint fields are not used for networking.
- Added a Telegram document reader boundary with declared and streamed 64 KiB limits and no disk writes.
- Replaced the `gdrive_auth` handler, command entry, and legacy menu action with `/gdrive connect`; `/gdrive disconnect` requires a bound confirmation callback.
- Added English, Ukrainian, and Russian setup/disconnect strings.

## TDD evidence

Initial focused run was RED as required:

```text
test/archive/application/drive-connection-workflow.test.ts: missing ConfirmDriveAccountUseCase
test/telegram/infrastructure/telegram-drive-client-document.adapter.test.ts: missing TelegramDriveClientDocumentAdapter
test/telegram/interfaces/gdrive.handler.test.ts: handleDocument is not a function
```

The final focused run was GREEN:

```text
yarn test test/telegram/interfaces/gdrive.handler.test.ts test/telegram/infrastructure/telegram-drive-client-document.adapter.test.ts test/archive/application/drive-connection-workflow.test.ts test/locales
9 files passed, 41 tests passed.
```

Additional compatibility checks passed:

```text
yarn test test/telegram/interfaces/home.handler.test.ts test/telegram/interfaces/gdrive.handler.test.ts test/telegram/infrastructure/telegram-drive-client-document.adapter.test.ts test/archive/application/drive-connection-workflow.test.ts
4 files passed, 47 tests passed.

yarn build
passed.

git diff --check
passed (Git emitted the pre-existing fsmonitor IPC warning only).
```

## Known unrelated verification issue

`test/telegram/telegram.module.composition.test.ts` cannot complete its Nest application bootstrap because `ImportCameraLiveSourcesUseCase` lacks `RtspSourceStartGate` in `TelegramModule`. This pre-existing camera DI failure is outside Task 7; the focused Task 7 checks and TypeScript build pass.
