import { describe, expect, it, vi } from 'vitest';
import { ConfigHandler } from '../../../src/telegram/interfaces/config.handler';
import { en } from '../../../src/locales/en';
import { catalogFor } from '../../../src/locales';

function localeState(locale: 'en' | 'uk' = 'en') {
  return { catalog: catalogFor(locale) };
}

function callbackData(reply: ReturnType<typeof vi.fn>, index = reply.mock.calls.length - 1): string[] {
  return reply.mock.calls[index]?.[1]?.reply_markup?.inline_keyboard?.flat()
    .map((button: { callback_data?: string }) => button.callback_data)
    .filter((data: string | undefined): data is string => typeof data === 'string') ?? [];
}

function keyboardText(reply: ReturnType<typeof vi.fn>, index = reply.mock.calls.length - 1): string[] {
  return reply.mock.calls[index]?.[1]?.reply_markup?.inline_keyboard?.flat()
    .map((button: { text: string }) => button.text) ?? [];
}

describe('ConfigHandler', () => {
  function createTestSetup() {
    const sensors = {
      listEnabled: vi.fn().mockResolvedValue([
        { name: 'front_door', type: 'digital', config: { pin: 4 } },
        { name: 'motion', type: 'digital', config: { pin: 17 } },
      ]),
      findById: vi.fn(),
      findByName: vi.fn(),
    } as any;
    const addSensor = { execute: vi.fn().mockImplementation((arg) => Promise.resolve({ name: arg.name })) } as any;
    const modifySensor = { execute: vi.fn() } as any;
    const removeSensor = { execute: vi.fn() } as any;
    const guard = { registered: vi.fn() } as any;

    const handler = new ConfigHandler(sensors, addSensor, modifySensor, removeSensor, guard);

    const commandCallbacks: Record<string, (...args: any[]) => any> = {};
    const callbackQueryCallbacks: { regex: RegExp; fn: (...args: any[]) => any }[] = [];
    const messageCallbacks: Record<string, (...args: any[]) => any> = {};

    const composer = {
      command: vi.fn((cmd, middleware, fn) => {
        commandCallbacks[cmd] = fn || middleware;
      }),
      callbackQuery: vi.fn((regex, middleware, fn) => {
        callbackQueryCallbacks.push({ regex, fn: fn || middleware });
      }),
      on: vi.fn((event, middleware, fn) => {
        messageCallbacks[event] = fn || middleware;
      }),
    } as any;

    handler.register(composer);

    return {
      handler,
      sensors,
      addSensor,
      modifySensor,
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
      callbackQuery: { data: 'cfg:type:digital' },
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
    expect(keyboard).toContain('cfg:pin:22');
    expect(keyboard).not.toContain('cfg:pin:4');
    expect(keyboard).not.toContain('cfg:pin:17');
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
    await cbFn({ from: { id: 501 }, callbackQuery: { data: 'cfg:type:digital' }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    // Step 2: name
    await msgFn({ from: { id: 501 }, message: { text: 'quick_sensor' }, reply } as any, vi.fn());
    // Step 3: choose a GPIO pin from the keyboard
    await cbFn({
      from: { id: 501 },
      callbackQuery: { data: 'cfg:pin:22' },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any);

    // Step 4: click smart defaults button
    const defaultCtx = {
      from: { id: 501 },
      callbackQuery: { data: 'cfg:default:digital' },
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
    await cbFn({ from: { id: 504 }, callbackQuery: { data: 'cfg:type:digital' }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    await msgFn({ from: { id: 504 }, message: { text: 'garage_door' }, reply } as any, vi.fn());
    await cbFn({ from: { id: 504 }, callbackQuery: { data: 'cfg:pin:4' }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);

    expect(reply).toHaveBeenCalledWith(en.config.pinTaken(4, 'front_door'), expect.anything());
    expect(JSON.stringify(reply.mock.calls[reply.mock.calls.length - 1][1].reply_markup)).toContain('cfg:pin:22');
  });

  it('keeps the wizard on the GPIO keyboard when a pin is typed', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks } = createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;
    const msgFn = messageCallbacks['message:text'];
    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

    await handler.handleSubcommand({ from: { id: 505 }, reply } as any, 'add');
    await cbFn({ from: { id: 505 }, callbackQuery: { data: 'cfg:type:digital' }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
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
    await cbFn({ from: { id: 502 }, callbackQuery: { data: 'cfg:type:digital' }, answerCallbackQuery, editMessageReplyMarkup, reply } as any);
    // Step 2: name
    await msgFn({ from: { id: 502 }, message: { text: 'back_sensor' }, reply } as any, vi.fn());

    // Click Back from Step 3 -> should return to Step 2 (addName)
    const backCtx = {
      from: { id: 502 },
      callbackQuery: { data: 'cfg:back:addName' },
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
      callbackQuery: { data: 'cfg:mod:front_door' },
      answerCallbackQuery,
      editMessageReplyMarkup,
      reply,
    } as any);

    await cbFn({
      from: { id: 503 },
      callbackQuery: { data: 'cfg:modify:pin' },
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

  it('cancels an active add wizard without mutating sensors', async () => {
    const { handler, messageCallbacks, addSensor } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    await handler.handleSubcommand({
      from: { id: 600 },
      reply,
      localeState: localeState('uk'),
    } as never, 'add');

    expect(callbackData(reply)).toContain('rh:f:c');
    expect(keyboardText(reply)).toContain('🏠 Дім');
    handler.cancelPending(600);
    const next = vi.fn();
    await messageCallbacks['message:text']({
      from: { id: 600 },
      message: { text: 'ignored_name' },
      reply,
    }, next);

    expect(next).toHaveBeenCalledOnce();
    expect(addSensor.execute).not.toHaveBeenCalled();
  });

  it('keeps cancel-pending Home with modify and remove selections', async () => {
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
    expect(callbackData(reply)).toContain('cfg:mod:front_door');
    expect(callbackData(reply)).toContain('rh:f:c');

    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });
    await callback({ ...callbackContext, callbackQuery: { data: 'cfg:mod:front_door' } } as never);
    expect(callbackData(reply)).toContain('cfg:modify:done');
    expect(callbackData(reply)).toContain('rh:f:c');

    await handler.handleSubcommand({ ...callbackContext, from: { id: 602 } } as never, 'remove');
    expect(callbackData(reply)).toContain('cfg:rem:front_door');
    expect(callbackData(reply)).toContain('rh:f:c');
    await callback({ ...callbackContext, from: { id: 602 }, callbackQuery: { data: 'cfg:rem:front_door' } } as never);
    expect(callbackData(reply)).toContain('cfg:rm:confirm');
    expect(callbackData(reply)).toContain('rh:f:c');
  });

  it('keeps cancel-pending Home on validation replies and retained modify results', async () => {
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
    await callback({ ...shared, from: { id: 603 }, callbackQuery: { data: 'cfg:type:digital' } } as never);
    await messageCallbacks['message:text']({ from: { id: 603 }, message: { text: 'shed' }, reply, localeState: localeState('uk') }, vi.fn());
    await messageCallbacks['message:text']({ from: { id: 603 }, message: { text: '22' }, reply, localeState: localeState('uk') }, vi.fn());
    expect(reply).toHaveBeenCalledWith(en.config.gpioPickerOnly, expect.objectContaining({ reply_markup: expect.anything() }));
    expect(callbackData(reply)).toContain('rh:f:c');

    sensors.findByName.mockResolvedValue({
      kind: 'active',
      sensor: { id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' },
    });
    sensors.findById.mockResolvedValue({ id: 'front-id', name: 'front_door', type: 'digital', config: { pin: 4 }, debounceMs: 100, severity: 'info' });
    await handler.handleSubcommand({ ...shared, from: { id: 604 } } as never, 'modify');
    await callback({ ...shared, from: { id: 604 }, callbackQuery: { data: 'cfg:mod:front_door' } } as never);
    await callback({ ...shared, from: { id: 604 }, callbackQuery: { data: 'cfg:modify:invert' } } as never);
    expect(modifySensor.execute).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ config: expect.anything() }) }));
    expect(callbackData(reply)).toContain('cfg:modify:done');
    expect(callbackData(reply)).toContain('rh:f:c');
  });

  it('uses terminal Home after successful add and state-free config replies', async () => {
    const { handler, callbackQueryCallbacks, messageCallbacks, sensors } = createTestSetup();
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
    await callback({ ...shared, callbackQuery: { data: 'cfg:type:digital' } } as never);
    await messageCallbacks['message:text']({ from: { id: 605 }, message: { text: 'quick' }, reply, localeState: localeState('uk') }, vi.fn());
    await callback({ ...shared, callbackQuery: { data: 'cfg:pin:22' } } as never);
    await callback({ ...shared, callbackQuery: { data: 'cfg:default:digital' } } as never);
    expect(callbackData(reply)).toEqual(['rh:f:t']);
    expect(keyboardText(reply)).toEqual(['🏠 Дім']);

    sensors.listEnabled.mockResolvedValueOnce([]);
    await handler.handleSubcommand({ from: { id: 606 }, reply, localeState: localeState('uk') } as never, 'remove');
    expect(callbackData(reply)).toEqual(['rh:f:t']);
  });
});
