# Task 2 — Return Home for config and export

## Changes

- Added one `ConfigHandler.returnKeyboard` builder using the current locale catalog and the config workflow phase.
- Appended a `cancelPending` Home row to all active add, modify, remove, validation, picker, back-navigation, and recoverable error responses while preserving existing `cfg:` controls.
- Added an `alreadyTerminal` Home-only keyboard after state deletion and for state-free config replies.
- Added terminal Home navigation to successful `/export_config` document replies and export failures.

## Tests

- RED: `yarn test test/telegram/interfaces/config.handler.test.ts test/telegram/interfaces/export-config.handler.test.ts` failed with six expected missing-`rh:f:*` assertions before production changes.
- GREEN: the same focused command passed: 2 files, 14 tests.
- Build: `yarn build` passed.
- Full suite: `yarn test` ran and Task 2 tests passed, but the overall suite failed with 8 unrelated `test/camera/infrastructure/quick-tunnel-rtsp-live-stream.adapter.test.ts` failures. Each is caused by sandbox Unix-domain-socket binding denial (`listen EPERM` under `/tmp/quick-rtsp-*`), not by these changes.

## Files changed

- `src/telegram/interfaces/config.handler.ts`
- `src/telegram/interfaces/export-config.handler.ts`
- `test/telegram/interfaces/config.handler.test.ts`
- `test/telegram/interfaces/export-config.handler.test.ts`

## Self-review

- Every `ConfigHandler` reply was checked: replies while the per-user state exists use `cancelPending`; success/cancel/no-state replies use `alreadyTerminal`.
- Existing config callbacks, parse modes, state transitions, sensor mutations, and YAML export contents are unchanged.
- The Home button is appended on its own final row when existing controls are present; terminal-only replies use a single Home row.

## Concerns

- The full-suite RTSP failures require an environment that permits binding the test Unix sockets; they were not modified or masked.

## Review follow-up — b9be7b8..b79e602

- `ConfigHandler` now derives the Home phase from the live per-user config state for empty modify/remove lists, not-found replies, and usage replies. Those paths do not mutate the FSM state.
- Added direct state-matrix coverage for Return Home cancellation of modify selection and remove confirmation, recoverable `replyError` navigation with retained state, and terminal Home after Done, remove success, and explicit cancel.

## Review test evidence

- RED: `yarn test test/telegram/interfaces/config.handler.test.ts` exited 1 before the phase fix: 1 failed / 13 total. The new empty-list assertion expected `rh:f:c` but received `rh:f:t` at `config.handler.test.ts:405`.
- GREEN: `yarn test test/telegram/interfaces/config.handler.test.ts test/telegram/interfaces/export-config.handler.test.ts` exited 0: 2 test files passed, 18 tests passed (config: 16; export: 2).
