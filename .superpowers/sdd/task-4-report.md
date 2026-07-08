Task 4 report — Honest "too large for Telegram" Drive fallback

Status: DONE

Commit:
- `fix(telegram): stop fabricating Drive URLs for oversized videos`

Implementation summary:
- Updated `en.camera.driveLinkFallback` to show the stored rclone remote path directly instead of fabricating a `drive.google.com/file/d/...` URL.
- Changed `CameraHandler.handleVideo()` to pass `delivery.event.gdriveFileId` straight into the locale string, with a comment clarifying that the field stores an rclone remote path.
- Removed the unused `driveUrl()` helper and the now-unused `MotionEvent` import from the camera handler.
- Added a schema comment on `motionEvents.gdriveFileId` documenting that it stores the rclone remote path, not a Google Drive API file id.
- Added a focused regression test under `test/telegram/interfaces/` to lock in the honest fallback copy.

RED / GREEN evidence:

RED:
- Added `test/telegram/interfaces/drive-link-fallback.test.ts` first.
- Ran:
  ```bash
  yarn test test/telegram/interfaces/drive-link-fallback.test.ts
  ```
- Result before implementation:
  ```text
   × en.camera.driveLinkFallback > explains when no Drive copy exists yet
     → expected '📹 event #7 is too large for telegram…' to contain 'no drive copy'

  Received: "📹 Event #7 is too large for Telegram and has no Drive link yet."
  ```

GREEN:
- Ran the focused test after implementation:
  ```text
  ✓ test/telegram/interfaces/drive-link-fallback.test.ts (2 tests)
  ```
- Ran the repo checks requested by the brief:
  ```bash
  yarn lint && yarn build
  ```
- Result:
  ```text
  exit code 0
  ```

Files changed:
- `src/locales/en.ts`
- `src/telegram/interfaces/camera.handler.ts`
- `src/database/schema.ts`
- `test/telegram/interfaces/drive-link-fallback.test.ts`

Self-review:
- The fallback now reports the actual stored path, which matches the data written by upload marking and avoids inventing dead Drive links.
- The handler change stays minimal and only touches the oversized-video branch.
- The schema change is comment-only, so no migration or `yarn db:generate` was needed.
- Lint and build both passed after the import cleanup, so there are no obvious typing or unused-code regressions.

Concerns:
- None.
