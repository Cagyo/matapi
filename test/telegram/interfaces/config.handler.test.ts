import { describe, expect, it, vi } from 'vitest';
import { ConfigHandler } from '../../../src/telegram/interfaces/config.handler';
import { en } from '../../../src/locales/en';
import { catalogFor } from '../../../src/locales';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';

function localeState(locale: 'en' | 'uk' = 'en') {
  return { catalog: catalogFor(locale) };
}

function callbackData(reply: ReturnType<typeof vi.fn>, index = reply.mock.calls.length - 1): string[] {
  const options: unknown = reply.mock.calls[index]?.[1];
  const keyboard = (options as { reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } } | undefined)
    ?.reply_markup?.inline_keyboard;
  return keyboard?.flat()
    .map((button: { callback_data?: string }) => button.callback_data)
    .filter((data: string | undefined): data is string => typeof data === 'string') ?? [];
}

function keyboardText(reply: ReturnType<typeof vi.fn>, index = reply.mock.calls.length - 1): string[] {
  const options: unknown = reply.mock.calls[index]?.[1];
  const keyboard = (options as { reply_markup?: { inline_keyboard?: { text: string }[][] } } | undefined)
    ?.reply_markup?.inline_keyboard;
  return keyboard?.flat()
    .map((button: { text: string }) => button.text) ?? [];
}

function receiptFor(userId: number, workflow: WorkflowReturnReceipt['payload']['workflow'] = 'sensor-add') {
  return {
    id: `a${String(userId).padStart(15, '0')}`,
    userId,
    chatId: userId,
    kind: 'workflow-return',
    sessionToken: null,
    status: 'pending',
    expiresAt: new Date('2030-01-02T00:00:00.000Z'),
    payload: {
      workflow,
      phase: 'cancellable',
      originSource: 'natural-parent',
      origin: { kind: 'admin-sensor-setup' },
    },
  } satisfies WorkflowReturnReceipt;
}

function configData(userId: number, action: string): string {
  return `cfg:${receiptFor(userId).id}:${action}`;
}

function fixturePrivateChat(ctx: any): any {
  if (!ctx.chat && typeof ctx.from?.id === 'number') {
    ctx.chat = { id: ctx.from.id, type: 'private' };
  }
  return ctx;
}

describe('ConfigHandler', () => {
  function createTestSetup() {
    const enabledSensors = [
      { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
      { id: 'motion-id', name: 'motion', type: 'digital', config: { pin: 17 }, debounceMs: 100, severity: 'info' },
    ];
    const sensors = {
      listEnabled: vi.fn().mockResolvedValue(enabledSensors),
      findById: vi.fn(async (id: string) => enabledSensors.find((sensor) => sensor.id === id) ?? null),
      findByName: vi.fn(),
    } as any;
    const addSensor = { execute: vi.fn().mockImplementation((arg) => Promise.resolve({ name: arg.name })) } as any;
    const modifySensor = { execute: vi.fn() } as any;
    const removeSensor = { execute: vi.fn() } as any;
    const guard = { registered: vi.fn() } as any;

    const workflows = {
      begin: vi.fn(async (ctx: { from?: { id?: number } }, workflow: WorkflowReturnReceipt['payload']['workflow']) =>
        receiptFor(ctx.from?.id ?? 0, workflow)),
    };
    const drafts = new WorkflowDraftRegistry();
    const navigation = {
      complete: vi.fn(async (
        _ctx: unknown,
        launch: { receipt: WorkflowReturnReceipt },
        presentation: { effectStage: 'pending' | 'already-delivered'; deliver(): Promise<void> },
      ) => {
        if (presentation.effectStage === 'pending') await presentation.deliver();
        await drafts.cancelExact(launch.receipt);
      }),
    };
    const handler = new ConfigHandler(
      sensors,
      addSensor,
      modifySensor,
      removeSensor,
      guard,
      workflows as never,
      drafts,
      navigation as never,
    );

    const commandCallbacks: Record<string, (...args: any[]) => any> = {};
    const callbackQueryCallbacks: { regex: RegExp; fn: (...args: any[]) => any }[] = [];
    const messageCallbacks: Record<string, (...args: any[]) => any> = {};

    const composer = {
      command: vi.fn((cmd, middleware, fn) => {
        const callback = fn || middleware;
        commandCallbacks[cmd] = async (ctx, ...args) => {
          await callback(fixturePrivateChat(ctx), ...args);
        };
      }),
      callbackQuery: vi.fn((regex, middleware, fn) => {
        const callback = fn || middleware;
        callbackQueryCallbacks.push({ regex, fn: async (ctx, ...args) => {
          await callback(fixturePrivateChat(ctx), ...args);
        } });
      }),
      on: vi.fn((event, middleware, fn) => {
        const callback = fn || middleware;
        messageCallbacks[event] = async (ctx, ...args) => {
          await callback(fixturePrivateChat(ctx), ...args);
        };
      }),
    } as any;

    handler.register(composer);

    return {
      handler,
      sensors,
      addSensor,
      modifySensor,
      removeSensor,
      workflows,
      drafts,
      navigation,
      commandCallbacks,
      callbackQueryCallbacks,
      messageCallbacks,
    };
  }

  it('displays active pins when entering GPIO pin selection step', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, sensors } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;
    const msgFn = messageCallbacks['message:text'];

    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    // Initialize state
    await handler.handleSubcommand({ from: { id: 500 }, reply } as any, 'add');

    // Step 1: select digital
    const step1Ctx = {
      from: { id: 500 },
      callbackQuery: { data: configData(500, 'type:digital') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any;
    await cbFn(step1Ctx);
    expect(reply).toHaveBeenCalledWith(en.config.step2('digital'), expect.anything());

    // Step 2: send name
    const step2Ctx = {
      from: { id: 500 },
      message: { text: 'my_sensor' },
      reply,
    } as any;
    await msgFn(step2Ctx, vi.fn());

    expect(sensors.listEnabled).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Currently used: Pin 4 (front_door), Pin 17 (motion)'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Raspberry Pi GPIO Pinout (BCM)'),
      expect.anything(),
    );
    const keyboard = JSON.stringify(reply.mock.calls[reply.mock.calls.length - 1][1].reply_markup);
    expect(keyboard).toContain(configData(500, 'pin:22'));
    expect(keyboard).not.toContain(configData(500, 'pin:4'));
    expect(keyboard).not.toContain(configData(500, 'pin:17'));
  });

  it('supports smart default creation from step 4 of digital sensor setup', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, addSensor } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;
    const msgFn = messageCallbacks['message:text'];

    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    // Initialize state
    await handler.handleSubcommand({ from: { id: 501 }, reply } as any, 'add');

    // Step 1: digital
    await cbFn({ from: { id: 501 }, callbackQuery: { data: configData(501, 'type:digital') }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    // Step 2: name
    await msgFn({ from: { id: 501 }, message: { text: 'quick_sensor' }, reply } as any, vi.fn());
    // Step 3: choose a GPIO pin from the keyboard
    await cbFn({
      from: { id: 501 },
      callbackQuery: { data: configData(501, 'pin:22') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any);

    // Step 4: click smart defaults button
    const defaultCtx = {
      from: { id: 501 },
      callbackQuery: { data: configData(501, 'default:digital') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any;
    await cbFn(defaultCtx);

    expect(addSensor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'quick_sensor',
        type: 'digital',
        config: expect.objectContaining({ pin: 22, activeLow: true, pull: 'up' }),
        debounceMs: 100,
      }),
    );
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('quick_sensor'), expect.anything());
  });

  it('rejects a stale GPIO selection and refreshes the available-pin keyboard', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;
    const msgFn = messageCallbacks['message:text'];
    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    await handler.handleSubcommand({ from: { id: 504 }, reply } as any, 'add');
    await cbFn({ from: { id: 504 }, callbackQuery: { data: configData(504, 'type:digital') }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    await msgFn({ from: { id: 504 }, message: { text: 'garage_door' }, reply } as any, vi.fn());
    await cbFn({ from: { id: 504 }, callbackQuery: { data: configData(504, 'pin:4') }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);

    expect(reply).toHaveBeenCalledWith(en.config.pinTaken(4, 'front_door'), expect.anything());
    expect(JSON.stringify(reply.mock.calls[reply.mock.calls.length - 1][1].reply_markup)).toContain(configData(504, 'pin:22'));
  });

  it('keeps the wizard on the GPIO keyboard when a pin is typed', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;
    const msgFn = messageCallbacks['message:text'];
    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    await handler.handleSubcommand({ from: { id: 505 }, reply } as any, 'add');
    await cbFn({ from: { id: 505 }, callbackQuery: { data: configData(505, 'type:digital') }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    await msgFn({ from: { id: 505 }, message: { text: 'shed_door' }, reply } as any, vi.fn());
    await msgFn({ from: { id: 505 }, message: { text: '22' }, reply } as any, vi.fn());

    expect(reply).toHaveBeenCalledWith(en.config.gpioPickerOnly, expect.anything());
  });

  it('supports step-back navigation via cfg:back callbacks', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;
    const msgFn = messageCallbacks['message:text'];

    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    // Initialize state
    await handler.handleSubcommand({ from: { id: 502 }, reply } as any, 'add');

    // Step 1: digital
    await cbFn({ from: { id: 502 }, callbackQuery: { data: configData(502, 'type:digital') }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    // Step 2: name
    await msgFn({ from: { id: 502 }, message: { text: 'back_sensor' }, reply } as any, vi.fn());

    // Click Back from Step 3 -> should return to Step 2 (addName)
    const backCtx = {
      from: { id: 502 },
      callbackQuery: { data: configData(502, 'back:addName') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any;
    await cbFn(backCtx);

    expect(reply).toHaveBeenCalledWith(en.config.step2('digital'), expect.anything());
  });

  it('displays Raspberry Pi pinout schema when modifying GPIO pin', async () => {
    const { handler, callbackQueryCallbacks, sensors } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;

    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 's-1', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });

    await handler.handleSubcommand({ from: { id: 503 }, reply } as any, 'modify');
    await cbFn({
      from: { id: 503 },
      callbackQuery: { data: configData(503, 'mod:0') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any);

    await cbFn({
      from: { id: 503 },
      callbackQuery: { data: configData(503, 'modify:pin') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any);

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Raspberry Pi GPIO Pinout (BCM)'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('explains digital hardware terms in the modify summary', () => {
    const summary = en.config.modifyHeader({
      name: 'front_door',
      type: 'digital',
      config: { pin: 17, activeLow: true, pull: 'up' },
      debounceMs: 100,
      severity: 'info',
    });

    expect(summary).toContain('Active Low: Yes — triggered when the signal is low');
    expect(summary).toContain('Pull: Up — keeps the input stable when unconnected');
    expect(summary).toContain('Debounce: 100ms — ignores repeat signals briefly');
  });

  it('explains active-high and no-pull wiring accurately', () => {
    const summary = en.config.modifyHeader({
      name: 'gate_sensor',
      type: 'digital',
      config: { pin: 17, activeLow: false, pull: 'none' },
      debounceMs: 100,
      severity: 'info',
    });

    expect(summary).toContain('Active Low: No — triggered when the signal is high');
    expect(summary).toContain('Pull: None — no internal resistor; use external wiring to keep the input stable');
  });

  it('cleans up an exact add draft without mutating sensors', async () => {
    const { handler, messageCallbacks, addSensor } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    await handler.handleSubcommand({
      from: { id: 600 },
      reply,
      localeState: localeState('uk'),
    } as never, 'add');

    expect(callbackData(reply)).toContain(`wr:${receiptFor(600).id}:o`);
    expect(callbackData(reply)).toContain(`wr:${receiptFor(600).id}:h`);
    expect(keyboardText(reply)).toContain(catalogFor('uk').config.cancelSensorSetup);
    expect(keyboardText(reply)).toContain('🏠 Дім');
    await handler.cancelExact({ userId: 600, chatId: 600, receiptId: receiptFor(600).id });
    const next = vi.fn();
    await messageCallbacks['message:text']({
      from: { id: 600 },
      message: { text: 'ignored_name' },
      reply,
    }, next);

    expect(next).toHaveBeenCalledOnce();
    expect(addSensor.execute).not.toHaveBeenCalled();
  });

  it('binds selection and exit controls to the current workflow receipt', async () => {
    const { handler, callbackQueryCallbacks, sensors } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const callbackContext = {
      from: { id: 601 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
      localeState: localeState('uk'),
    };

    await handler.handleSubcommand(callbackContext as never, 'modify');
    expect(callbackData(reply)).toContain(configData(601, 'mod:0'));
    expect(callbackData(reply)).toEqual(expect.arrayContaining([
      `wr:${receiptFor(601).id}:o`,
      `wr:${receiptFor(601).id}:h`,
    ]));

    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });
    await callback({ ...callbackContext, callbackQuery: { data: configData(601, 'mod:0') } });
    expect(callbackData(reply)).toContain(configData(601, 'modify:done'));
    expect(callbackData(reply)).toEqual(expect.arrayContaining([
      `wr:${receiptFor(601).id}:o`,
      `wr:${receiptFor(601).id}:h`,
    ]));

    await handler.handleSubcommand({ ...callbackContext, from: { id: 602 } } as never, 'remove');
    expect(callbackData(reply)).toContain(configData(602, 'rem:0'));
    expect(callbackData(reply)).toEqual(expect.arrayContaining([
      `wr:${receiptFor(602).id}:o`,
      `wr:${receiptFor(602).id}:h`,
    ]));
    await callback({ ...callbackContext, from: { id: 602 }, callbackQuery: { data: configData(602, 'rem:0') } });
    expect(callbackData(reply)).toContain(configData(602, 'rm:confirm'));
    expect(callbackData(reply)).toEqual(expect.arrayContaining([
      `wr:${receiptFor(602).id}:o`,
      `wr:${receiptFor(602).id}:h`,
    ]));
  });

  it('keeps bound exit controls on validation replies and retained modify results', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, sensors, modifySensor } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const shared = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
      localeState: localeState('uk'),
    };

    await handler.handleSubcommand({ ...shared, from: { id: 603 } } as never, 'add');
    await callback({ ...shared, from: { id: 603 }, callbackQuery: { data: configData(603, 'type:digital') } });
    await messageCallbacks['message:text']({ from: { id: 603 }, message: { text: 'shed' }, reply, localeState: localeState('uk') }, vi.fn());
    await messageCallbacks['message:text']({ from: { id: 603 }, message: { text: '22' }, reply, localeState: localeState('uk') }, vi.fn());
    expect(reply).toHaveBeenCalledWith(en.config.gpioPickerOnly, expect.objectContaining({ reply_markup: expect.anything() }));
    expect(callbackData(reply)).toContain(`wr:${receiptFor(603).id}:o`);

    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });
    sensors.findById.mockResolvedValue({ id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' });
    await handler.handleSubcommand({ ...shared, from: { id: 604 } } as never, 'modify');
    await callback({ ...shared, from: { id: 604 }, callbackQuery: { data: configData(604, 'mod:0') } });
    await callback({ ...shared, from: { id: 604 }, callbackQuery: { data: configData(604, 'modify:invert') } });
    expect(modifySensor.execute).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ config: expect.anything() }) }));
    expect(callbackData(reply)).toContain(configData(604, 'modify:done'));
    expect(callbackData(reply)).toContain(`wr:${receiptFor(604).id}:o`);
  });

  it('delivers terminal outcomes through contextual restoration', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, sensors, navigation } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const shared = {
      from: { id: 605 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
      localeState: localeState('uk'),
    };

    await handler.handleSubcommand(shared as never, 'add');
    await callback({ ...shared, callbackQuery: { data: configData(605, 'type:digital') } });
    await messageCallbacks['message:text']({ from: { id: 605 }, message: { text: 'quick' }, reply, localeState: localeState('uk') }, vi.fn());
    await callback({ ...shared, callbackQuery: { data: configData(605, 'pin:22') } });
    await callback({ ...shared, callbackQuery: { data: configData(605, 'default:digital') } });
    expect(navigation.complete).toHaveBeenCalledWith(
      expect.anything(),
      { receipt: receiptFor(605) },
      expect.objectContaining({ effectStage: 'pending' }),
    );

    sensors.listEnabled.mockResolvedValueOnce([]);
    await handler.handleSubcommand({ from: { id: 606 }, reply, localeState: localeState('uk') } as never, 'remove');
    expect(navigation.complete).toHaveBeenCalledWith(
      expect.anything(),
      { receipt: receiptFor(606, 'sensor-remove') },
      expect.objectContaining({ effectStage: 'pending' }),
    );
  });

  it('supersedes an older configuration draft before reporting an empty direct workflow', async () => {
    const { handler, messageCallbacks, sensors, navigation } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const userId = 607;
    const context = { from: { id: userId }, reply, localeState: localeState('uk') };

    await handler.handleSubcommand(context as never, 'add');
    sensors.listEnabled.mockResolvedValue([]);
    await handler.handleSubcommand(context as never, 'modify');
    expect(navigation.complete).toHaveBeenCalledWith(
      context,
      { receipt: receiptFor(userId, 'sensor-modify') },
      expect.objectContaining({ effectStage: 'pending' }),
    );

    await handler.handleSubcommand(context as never, 'remove');
    const next = vi.fn();
    await messageCallbacks['message:text']({
      ...context,
      message: { text: 'still_active' },
    }, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects selection callbacks after the exact draft was cancelled', async () => {
    const { handler, callbackQueryCallbacks, removeSensor, sensors } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const callbackContext = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
      localeState: localeState('uk'),
    };
    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });

    await handler.handleSubcommand({ ...callbackContext, from: { id: 609 } } as never, 'modify');
    await handler.cancelExact({ userId: 609, chatId: 609, receiptId: receiptFor(609, 'sensor-modify').id });
    await callback({ ...callbackContext, from: { id: 609 }, callbackQuery: { data: configData(609, 'mod:0') } });
    expect(callbackContext.answerCallbackQuery).toHaveBeenCalled();

    await handler.handleSubcommand({ ...callbackContext, from: { id: 610 } } as never, 'remove');
    await callback({ ...callbackContext, from: { id: 610 }, callbackQuery: { data: configData(610, 'rem:0') } });
    expect(callbackData(reply)).toContain(configData(610, 'rm:confirm'));
    await handler.cancelExact({ userId: 610, chatId: 610, receiptId: receiptFor(610, 'sensor-remove').id });
    await callback({ ...callbackContext, from: { id: 610 }, callbackQuery: { data: configData(610, 'rm:confirm') } });
    expect(removeSensor.execute).not.toHaveBeenCalled();
  });

  it('keeps receipt-bound exit controls when an error leaves a config state active', async () => {
    const { handler, callbackQueryCallbacks, sensors } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const callbackContext = {
      from: { id: 611 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
      localeState: localeState('uk'),
    };
    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });

    await handler.handleSubcommand(callbackContext as never, 'modify');
    await callback({ ...callbackContext, callbackQuery: { data: configData(611, 'mod:0') } });
    sensors.findById.mockResolvedValue(undefined);
    await callback({ ...callbackContext, callbackQuery: { data: configData(611, 'modify:invert') } });
    expect(callbackData(reply)).toEqual([
      `wr:${receiptFor(611).id}:o`,
      `wr:${receiptFor(611).id}:h`,
    ]);

    await callback({ ...callbackContext, callbackQuery: { data: configData(611, 'modify:done') } });
    expect(callbackData(reply)).toEqual([]);
  });

  it('routes Done and removal completion through the contextual coordinator', async () => {
    const { handler, callbackQueryCallbacks, sensors, navigation } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const callbackContext = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
      localeState: localeState('uk'),
    };
    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });

    await handler.handleSubcommand({ ...callbackContext, from: { id: 612 } } as never, 'modify');
    await callback({ ...callbackContext, from: { id: 612 }, callbackQuery: { data: configData(612, 'mod:0') } });
    await callback({ ...callbackContext, from: { id: 612 }, callbackQuery: { data: configData(612, 'modify:done') } });
    expect(navigation.complete).toHaveBeenCalledWith(
      expect.anything(),
      { receipt: receiptFor(612, 'sensor-modify') },
      expect.objectContaining({ effectStage: 'pending' }),
    );

    await handler.handleSubcommand({ ...callbackContext, from: { id: 613 } } as never, 'remove');
    await callback({ ...callbackContext, from: { id: 613 }, callbackQuery: { data: configData(613, 'rem:0') } });
    await callback({ ...callbackContext, from: { id: 613 }, callbackQuery: { data: configData(613, 'rm:confirm') } });
    expect(navigation.complete).toHaveBeenCalledWith(
      expect.anything(),
      { receipt: receiptFor(613, 'sensor-remove') },
      expect.objectContaining({ effectStage: 'pending' }),
    );
  });

  it('uses Sensor setup as the natural parent for direct sensor commands', async () => {
    const { commandCallbacks, sensors, workflows } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 701 }, match: 'modify front_door', reply } as any;
    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });

    await commandCallbacks.config(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'sensor-modify', {
      source: 'natural-parent',
    });
  });

  it('rejects an old receipt callback before it can change the newer draft', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, workflows } = createTestSetup();
    const first = receiptFor(702);
    const replacement = { ...receiptFor(702), id: 'ZyXwVu9876_-tsR5' } satisfies WorkflowReturnReceipt;
    workflows.begin.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 702 }, reply } as any;

    await handler.handleSubcommand(ctx, 'add');
    await handler.handleSubcommand(ctx, 'add');
    const replyCountBeforeOldControl = reply.mock.calls.length;
    await callbackQueryCallbacks[0].fn({
      from: { id: 702 },
      callbackQuery: { data: `cfg:${first.id}:type:digital` },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    });
    await messageCallbacks['message:text']({
      from: { id: 702 }, message: { text: 'old_name' }, reply,
    }, vi.fn());

    expect(reply).toHaveBeenCalledTimes(replyCountBeforeOldControl);
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();

    await callbackQueryCallbacks[0].fn({
      from: { id: 702 },
      callbackQuery: { data: `cfg:${replacement.id}:type:digital` },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    });
    expect(reply).toHaveBeenCalledWith(en.config.step2('digital'), expect.anything());
  });

  it('rejects config callbacks from a group or a different private chat', async () => {
    const { handler, callbackQueryCallbacks } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    await handler.handleSubcommand({
      from: { id: 705 },
      chat: { id: 705, type: 'private' },
      reply,
    } as never, 'add');
    const replyCount = reply.mock.calls.length;

    await callback({
      from: { id: 705 },
      chat: { id: -100, type: 'group' },
      callbackQuery: { data: configData(705, 'type:digital') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    });
    await callback({
      from: { id: 705 },
      chat: { id: 706, type: 'private' },
      callbackQuery: { data: configData(705, 'type:digital') },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    });

    expect(reply).toHaveBeenCalledTimes(replyCount);
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledTimes(2);
  });

  it('does not let a group or a different private chat submit text to a config draft', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, sensors } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const onText = messageCallbacks['message:text'];
    const reply = vi.fn().mockResolvedValue(true);
    const privateContext = {
      from: { id: 707 },
      chat: { id: 707, type: 'private' },
      reply,
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };

    await handler.handleSubcommand(privateContext as never, 'add');
    await callback({
      ...privateContext,
      callbackQuery: { data: configData(707, 'type:digital') },
    });
    const replyCount = reply.mock.calls.length;
    const groupNext = vi.fn();
    const otherChatNext = vi.fn();

    await onText({
      from: { id: 707 },
      chat: { id: -100, type: 'supergroup' },
      message: { text: 'group_sensor' },
      reply,
    }, groupNext);
    await onText({
      from: { id: 707 },
      chat: { id: 708, type: 'private' },
      message: { text: 'other_chat_sensor' },
      reply,
    }, otherChatNext);

    expect(groupNext).toHaveBeenCalledOnce();
    expect(otherChatNext).toHaveBeenCalledOnce();
    expect(sensors.listEnabled).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(replyCount);
  });

  it('uses compact receipt-bound selection indexes for long sensor names', async () => {
    const { handler, callbackQueryCallbacks, sensors } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const sensor = {
      id: 'sensor-long-id',
      name: `sensor_${'x'.repeat(160)}`,
      type: 'digital',
      config: { pin: 4 },
      debounceMs: 100,
      severity: 'info',
    };
    sensors.listEnabled.mockResolvedValueOnce([sensor]);
    sensors.findById.mockResolvedValue(sensor);
    const context = {
      from: { id: 709 },
      chat: { id: 709, type: 'private' },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
    };

    await handler.handleSubcommand(context as never, 'modify');
    const selection = callbackData(reply).find((data) => data.includes(':mod:'));

    expect(selection).toBe(configData(709, 'mod:0'));
    expect(selection).not.toContain(sensor.name);
    expect(Buffer.byteLength(selection ?? '', 'utf8')).toBeLessThanOrEqual(64);
    expect(callbackData(reply).every((data) => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);

    await callback({ ...context, callbackQuery: { data: selection } });

    expect(sensors.findById).toHaveBeenCalledWith(sensor.id);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining(sensor.name),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('ignores stale or malformed compact sensor selections without looking up a sensor', async () => {
    const { handler, callbackQueryCallbacks, sensors } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    const context = {
      from: { id: 710 },
      chat: { id: 710, type: 'private' },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply,
    };

    await handler.handleSubcommand(context as never, 'modify');
    const replyCount = reply.mock.calls.length;
    await callback({ ...context, callbackQuery: { data: 'cfg:ZyXwVu9876_-tsR5:mod:0' } });
    await callback({ ...context, callbackQuery: { data: configData(710, 'mod:not-an-index') } });
    await callback({ ...context, callbackQuery: { data: configData(710, 'mod:99') } });

    expect(sensors.findById).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(replyCount);
  });

  it('keeps /cancel scoped to the exact Config receipt and restores without a cancellation reply', async () => {
    const { handler, commandCallbacks, navigation } = createTestSetup();
    const next = vi.fn();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 703 }, reply } as any;

    await commandCallbacks.cancel(ctx, next);
    expect(next).toHaveBeenCalledOnce();

    await handler.handleSubcommand(ctx, 'add');
    await commandCallbacks.cancel(ctx, vi.fn());

    expect(navigation.complete).toHaveBeenCalledWith(
      ctx,
      { receipt: receiptFor(703) },
      expect.objectContaining({ effectStage: 'already-delivered' }),
    );
    expect(reply).not.toHaveBeenCalledWith(en.config.cancelled, expect.anything());
  });

  it('sends an unexpected terminal failure through contextual restoration', async () => {
    const { handler, callbackQueryCallbacks, sensors, removeSensor, navigation } = createTestSetup();
    const callback = callbackQueryCallbacks[0].fn;
    const reply = vi.fn().mockResolvedValue(true);
    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });
    removeSensor.execute.mockRejectedValueOnce(new Error('write failed'));

    await handler.handleSubcommand({ from: { id: 704 }, reply } as any, 'remove');
    await callback({
      from: { id: 704 }, callbackQuery: { data: configData(704, 'rem:0') },
      answerCallbackQuery: vi.fn().mockResolvedValue(true), editMessageReplyMarkup: vi.fn().mockResolvedValue(true), reply,
    });
    await callback({
      from: { id: 704 }, callbackQuery: { data: configData(704, 'rm:confirm') },
      answerCallbackQuery: vi.fn().mockResolvedValue(true), editMessageReplyMarkup: vi.fn().mockResolvedValue(true), reply,
    });

    expect(reply).toHaveBeenCalledWith(en.common.error('process /config', 'internal error'));
    expect(navigation.complete).toHaveBeenCalledWith(
      expect.anything(),
      { receipt: receiptFor(704, 'sensor-remove') },
      expect.objectContaining({ effectStage: 'pending' }),
    );
  });
});
