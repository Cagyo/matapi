# Task 5 — Sensor feature-management report

## Scope

- Added the canonical sensor-to-feature mapping: digital → digital, UART → uart,
  MQTT → zigbee, and camera → no feature gate.
- Gated sensor boot/reload, mutation use cases, async event fan-out, and the
  `/config add` type picker on published feature availability.
- Added serialized runtime stop/resume lifecycle registration for digital, UART,
  and zigbee; camera remains untouched for Task 6.
- Removed `PigpioGateway` eager `OnModuleInit` connection. GPIO connection stays
  in the idempotent digital adapter initialization path.

## RED evidence

Command run before the implementation changes:

```text
yarn test test/sensors/application/sensor-registry.service.test.ts \
  test/sensors/application/feature-sensor-runtime-lifecycle.service.test.ts \
  test/sensors/infrastructure/pigpio.gateway.test.ts
```

It failed as expected: the lifecycle service did not exist; registry did not
wait for the feature barrier, constructed unavailable drivers, did not expose
`stopFeature`, and stale callbacks persisted state. The add, modify, and import
gate tests also failed before their implementation because mutations completed
despite `FeatureUnavailableError`.

## GREEN evidence

```text
yarn test test/sensors/application test/telegram/interfaces/config.handler.test.ts \
  test/sensors/infrastructure/pigpio.gateway.test.ts
```

Result: 14 test files passed; 105 tests passed.

```text
yarn test test/sensors/sensor.module.test.ts
```

Result: 1 test file passed; 1 test passed, confirming exactly digital, uart,
and zigbee lifecycle registration.

```text
yarn tsc --noEmit
git diff --check
```

Both commands exited successfully.

## Notes

- Existing focused tests intentionally emit mocked Nest logger output for
  connection/recovery/error paths; the runs pass without test failures.
- Concurrent user changes under docs and prior task reports were preserved and
  are not part of this task's commit.
