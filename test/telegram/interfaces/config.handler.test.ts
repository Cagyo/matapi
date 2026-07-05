import { describe, expect, it, vi } from 'vitest';
import { ConfigHandler } from '../../../src/telegram/interfaces/config.handler';
import { en } from '../../../src/locales/en';

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
    // Step 3: pin
    await msgFn({ from: { id: 501 }, message: { text: '22' }, reply } as any, vi.fn());

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
      }),
    );
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('quick_sensor'));
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
});
