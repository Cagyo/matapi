# Telegram Alert Actions and Config UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make critical Telegram alerts lead directly to the relevant sensor logs and make digital GPIO configuration faster and clearer on mobile.

**Architecture:** Extend the event-to-Telegram notification contract with optional inline markup while keeping formatting in the domain and Telegram delivery in its adapter. Reuse the existing `LogsHandler` sensor lookup and delivery behaviour for the action callback. Enhance the existing in-memory configuration wizard state only; GPIO availability is queried through `SensorQueryPort` and collisions remain domain-error mapped.

**Tech Stack:** TypeScript, NestJS 10, grammY, Vitest, inline Telegram keyboards.

## Global Constraints

- All user-facing strings come from `src/locales/en.ts`.
- Handlers may access sensor data only through `SensorQueryPort`; no Drizzle access from Telegram interfaces.
- Preserve `/logs` message/file output and existing domain-error mapping.
- Use `← Back`, `❌ Close`, and `❌ Cancel` everywhere these actions appear.
- Do not stage or modify unrelated `scripts/` changes.

---

### Task 1: Alert-action delivery and sensor-log callback

**Files:**
- Modify: `src/events/domain/ports/notifier.port.ts`
- Modify: `src/events/application/notification.service.ts`
- Modify: `src/sensors/infrastructure/digital-gpio.adapter.ts`
- Modify: `src/telegram/infrastructure/telegram-notifier.adapter.ts`
- Modify: `src/telegram/interfaces/logs.handler.ts`
- Modify: `src/locales/en.ts`
- Test: `test/events/application/notification.service.test.ts`
- Test: `test/sensors/infrastructure/digital-gpio.adapter.test.ts`
- Test: `test/telegram/infrastructure/telegram-notifier.adapter.test.ts`
- Test: `test/telegram/interfaces/logs.handler.test.ts`

**Interfaces:**
- Produces `NotificationMessage.replyMarkup?: InlineKeyboardMarkup` for the Telegram adapter.
- Produces `LogsHandler.handleSensor(ctx, name)` so direct alert callbacks and `/logs` use the same lookup/delivery path.

- [ ] **Step 1: Write failing tests**

```ts
it('attaches a direct logs action to a critical sensor notification', async () => {
  await service.process(criticalSensorEvent);
  expect(notifier.notifyUser).toHaveBeenCalledWith(
    recipient.telegramId,
    expect.objectContaining({ replyMarkup: expect.anything() }),
  );
});

it('opens the named sensor logs from an alert callback', async () => {
  await callback(ctx('alert:logs:front_door'));
  expect(logs.findRecent).toHaveBeenCalledWith('sensor-id', { limit: 20 });
});
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `yarn test test/events/application/notification.service.test.ts test/telegram/infrastructure/telegram-notifier.adapter.test.ts test/telegram/interfaces/logs.handler.test.ts`

Expected: FAIL because alert markup and the `alert:logs:` callback route do not exist.

- [ ] **Step 3: Implement the smallest contract and routes**

```ts
export interface NotificationMessage {
  text: string;
  asFile: boolean;
  replyMarkup?: InlineKeyboardMarkup;
}

// NotificationService: critical sensor notifications include
// { inline_keyboard: [[{ text: en.alerts.viewLogs, callback_data: `logs:${sensor.name}` }]] }.
// DigitalGpioAdapter: report a flapping fault through the existing event path so
// it becomes a notification, rather than only appending a local log line.
// TelegramNotifierAdapter: pass reply_markup only to sendMessage.
// LogsHandler: route its existing `logs:` callback and the reusable direct path through handleSensor().
```

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run: `yarn test test/events/application/notification.service.test.ts test/telegram/infrastructure/telegram-notifier.adapter.test.ts test/telegram/interfaces/logs.handler.test.ts`

Expected: PASS with alert action, markup propagation, and direct logs delivery covered.

### Task 2: GPIO picker and plain-English config guidance

**Files:**
- Modify: `src/telegram/interfaces/config.handler.ts`
- Modify: `src/locales/en.ts`
- Test: `test/telegram/interfaces/config.handler.test.ts`

**Interfaces:**
- Produces callback payload `cfg:pin:<number>` accepted only during `addDigitalPin`.
- Produces `digitalPinKeyboard(usedPins)` with unassigned, valid BCM GPIO options and standard back/cancel controls.

- [ ] **Step 1: Write failing tests**

```ts
it('renders only unassigned GPIO pins after a digital sensor name is entered', async () => {
  await sendDigitalName('front_door');
  expect(serializedKeyboard(reply)).toContain('cfg:pin:17');
  expect(serializedKeyboard(reply)).not.toContain('cfg:pin:22');
});

it('advances from a GPIO picker callback without typed pin input', async () => {
  await callback(ctx('cfg:pin:17'));
  expect(reply).toHaveBeenCalledWith(expect.stringContaining('Active Low'), expect.anything());
});

it('explains debounce, active low, and pull up in modify guidance', async () => {
  await openModifyMenu();
  expect(reply).toHaveBeenCalledWith(expect.stringContaining('ignore repeat signals'), expect.anything());
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `yarn test test/telegram/interfaces/config.handler.test.ts`

Expected: FAIL because GPIO picker callbacks and explanatory copy do not exist.

- [ ] **Step 3: Implement the minimal picker and copy changes**

```ts
if (state.kind === 'addDigitalPin' && data.startsWith('cfg:pin:')) {
  await this.acceptDigitalPin(ctx, userId, state, Number(data.slice('cfg:pin:'.length)));
  return;
}

// build the keyboard from valid BCM GPIO candidates minus listEnabled() digital pins;
// preserve the authoritative AddSensorUseCase collision check and refresh the picker after PinAlreadyInUseError.
```

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `yarn test test/telegram/interfaces/config.handler.test.ts`

Expected: PASS with grid filtering, callback selection, collision recovery, and copy hints covered.

### Task 3: Navigation grammar and final quality pass

**Files:**
- Modify: `src/locales/en.ts`
- Modify: `src/telegram/interfaces/menu.handler.ts`
- Modify: `src/telegram/interfaces/camera.handler.ts`
- Test: `test/telegram/interfaces/menu.handler.test.ts`
- Test: `test/telegram/interfaces/camera.handler.test.ts`

**Interfaces:**
- Consumes locale-owned navigation labels.
- Produces normalized `← Back`, `❌ Close`, and `❌ Cancel` keyboards across menu, camera, and config paths.

- [ ] **Step 1: Write failing tests**

```ts
it('uses the shared close label in the camera dashboard', async () => {
  await commandCallbacks.camera(ctx());
  expect(serializedKeyboard(ctx().reply)).toContain('❌ Close');
});

it('uses the shared back label in menu submenus', async () => {
  await callback(menuContext('sub:sensors'));
  expect(serializedKeyboard(menuContext.reply)).toContain('← Back');
});
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `yarn test test/telegram/interfaces/menu.handler.test.ts test/telegram/interfaces/camera.handler.test.ts`

Expected: FAIL where literal or legacy labels differ from the shared grammar.

- [ ] **Step 3: Replace divergent labels with locale keys and cover callback edges**

```ts
export const en = {
  common: {
    backButton: '← Back',
    closeButton: '❌ Close',
    cancelButton: '❌ Cancel',
  },
};
```

- [ ] **Step 4: Run focused quality checks and the full suite**

Run: `yarn test test/telegram/interfaces/menu.handler.test.ts test/telegram/interfaces/camera.handler.test.ts && yarn test && yarn build`

Expected: all tests pass and the Nest build exits 0.
