# Digital Default Debounce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New digital sensors use a 100 ms debounce in every supported creation and import path.

**Architecture:** Keep defaults type-aware at the boundaries that create or reconstruct sensor configuration. `config/defaults.yml` remains the bot creation source, while import and legacy database fallbacks explicitly select 100 ms only for digital sensors. Existing stored values remain unchanged.

**Tech Stack:** TypeScript, NestJS, Vitest, YAML, Drizzle ORM.

## Global Constraints

- Preserve stored `sensors.debounce_ms` values.
- Preserve UART's 0 ms default and MQTT/camera's existing 10,000 ms fallback.
- Do not change the type-agnostic SQLite column default.
- Do not change notification text; the configured sensor name is already used.

---

### Task 1: Type-aware defaults and regression tests

**Files:**
- Modify: `config/defaults.yml`
- Modify: `src/telegram/interfaces/config.handler.ts`
- Modify: `src/sensors/domain/config-import.ts`
- Modify: `src/sensors/infrastructure/drizzle-sensor.query.ts`
- Modify: `src/sensors/infrastructure/drizzle-sensor.repository.ts`
- Test: `test/sensors/domain/config-import.test.ts`
- Test: `test/sensors/infrastructure/drizzle-sensor.query.test.ts`

**Interfaces:**
- Consumes: `SensorType`, persisted `sensors.debounce_ms`, and imported `debounce_ms`.
- Produces: `Sensor.debounceMs` of 100 for new/imported/legacy-null digital sensors.

- [ ] **Step 1: Write failing import and legacy-row tests**

```ts
expect(validateImportConfig({ sensors: [{
  name: 'front_door', type: 'digital', config: { pin: 17 }, severity: 'info',
}] })).toMatchObject({ ok: true, sensors: [{ debounceMs: 100 }] });

expect(query.findById('digital-null')).resolves.toMatchObject({ debounceMs: 100 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test test/sensors/domain/config-import.test.ts test/sensors/infrastructure/drizzle-sensor.query.test.ts`

Expected: assertions report `10000` rather than `100`.

- [ ] **Step 3: Implement type-aware defaults**

```ts
function defaultDebounceMs(type: SensorType): number {
  if (type === 'digital') return 100;
  if (type === 'uart') return 0;
  return 10_000;
}
```

Use this behavior for omitted import values and null persisted values. Set the YAML digital default to `100` and change the Telegram digital fallback to `100`.

- [ ] **Step 4: Run focused tests**

Run: `yarn test test/sensors/domain/config-import.test.ts test/sensors/infrastructure/drizzle-sensor.query.test.ts test/telegram/interfaces/config.handler.test.ts`

Expected: all selected test files pass.

- [ ] **Step 5: Update default documentation**

Change the documented digital default from 10,000 ms to 100 ms in the relevant sensor/configuration specifications, while retaining per-sensor override instructions.

- [ ] **Step 6: Verify and commit**

Run: `yarn build && git diff --check`

Then stage only files changed by this task and commit with: `fix(sensors): reduce default digital debounce`.
