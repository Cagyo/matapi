# Task 6 — Camera feature-management report

## RED

`yarn test test/camera/application/feature-camera-runtime-lifecycle.service.test.ts`

Result: failed because `FeatureCameraRuntimeLifecycleService` did not exist.

## GREEN

`yarn test test/camera/application test/telegram/application/get-home-screen.use-case.test.ts test/telegram/interfaces/camera.handler.test.ts test/telegram/interfaces/camera-sources.handler.test.ts test/telegram/interfaces/home-renderer.test.ts test/camera/camera-composition.test.ts test/camera/camera-runtime-composition.test.ts`

Result: 31 files passed, 255 tests passed.

`yarn tsc --noEmit`

Result: passed.

`git diff --check`

Result: passed.

## Scope

- Added keyed Motion and RTSP runtime lifecycle registration; the obsolete `FEATURE_DISABLE_LIFECYCLE` camera registration is removed.
- Motion watcher is explicitly startable/stoppable and rechecks availability around daemon effects.
- RTSP starts are fail-closed, lifecycle-opened, and guarded at source configuration/import and live stream start.
- Motion camera effects require feature readiness; Telegram camera controls display localized stale-state feedback and Home hides the Camera entry when neither capability is operational.

## Follow-up race coverage

- Stop during availability verification and restart backoff cannot arm a watcher or leave an in-flight sleep hanging.
- Deferred live-stream readiness creates pending state before awaiting and preserves a queued joiner.
- RTSP source removal rechecks availability after session teardown; Home tests cover Motion-only, RTSP-only, both, and neither.
- Stale callbacks use the active locale and do not mark workflows running.
- Replacement start rejection settles every pending request, while browse/source continuations and Home availability now fail closed.

No bootstrap limitation remains: the Camera module registers both keyed lifecycle entries directly.
