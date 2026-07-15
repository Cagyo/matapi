import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import {
  LogsHandler,
  parseArgs,
  parseDuration,
} from '../../../src/telegram/interfaces/logs.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

const enabledSensor = {
  id: 'sensor-1',
  name: 'front_door',
  type: 'digital' as const,
  config: {},
  enabled: true,
  debounceMs: 0,
  severity: 'info' as const,
  lastValue: null,
  lastValueAt: null,
};

const inlineEntries = [
  {
    sensorId: enabledSensor.id,
    timestamp: new Date('2026-07-11T08:00:00Z'),
    level: 'warn' as const,
    message: 'Alarm triggered',
  },
];

const entriesLongerThan4096 = [
  {
    ...inlineEntries[0],
    message: 'x'.repeat(4096),
  },
];

type LogsCallback = (ctx: Record<string, unknown>) => Promise<void>;

function callbackData(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const keyboard = (options as {
    reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
  }).reply_markup;
  return keyboard?.inline_keyboard?.flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string') ?? [];
}

function keyboardText(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const keyboard = (options as {
    reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> };
  }).reply_markup;
  return keyboard?.inline_keyboard?.flat().map((button) => button.text) ?? [];
}

function createSetup() {
  const sensors = {
    listEnabled: vi.fn().mockResolvedValue([enabledSensor]),
    findByIdIncludingArchived: vi.fn(),
    findByName: vi.fn().mockResolvedValue({ kind: 'active', sensor: enabledSensor }),
  };
  const logs = { findRecent: vi.fn().mockResolvedValue(inlineEntries) };
  const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
  const handler = new LogsHandler(sensors as never, logs as never, guard);
  const commands = new Map<string, LogsCallback>();
  let directLogsCallback: LogsCallback | undefined;
  handler.register({
    command: vi.fn((_command: string, _guard: unknown, callback: LogsCallback) => {
      commands.set(_command, callback);
    }),
    callbackQuery: vi.fn((_filter: RegExp, _guard: unknown, callback: LogsCallback) => {
      directLogsCallback = callback;
    }),
  } as never);

  return {
    commands,
    directLogsCallback: directLogsCallback as LogsCallback,
    handler,
    logs,
    sensors,
  };
}

function commandContext(match: string, locale?: 'en' | 'uk') {
  return {
    match,
    localeState: locale ? { catalog: catalogFor(locale) } : undefined,
    reply: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

function callbackContext(data: string, locale?: 'en' | 'uk') {
  return {
    from: { id: 1 },
    callbackQuery: { data },
    localeState: locale ? { catalog: catalogFor(locale) } : undefined,
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

function lastReplyOptions(ctx: ReturnType<typeof commandContext>): unknown {
  return ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1][1];
}

describe('logs.handler — parseArgs', () => {
  it('parses sensor name with default count', () => {
    const r = parseArgs('front_door');
    expect(r).toMatchObject({ name: 'front_door', count: 20 });
    expect(r.since).toBeUndefined();
    expect(r.invalid).toBeUndefined();
  });

  it('parses sensor name with explicit count', () => {
    const r = parseArgs('front_door 50');
    expect(r).toMatchObject({ name: 'front_door', count: 50 });
  });

  it('parses --since duration and bumps the cap', () => {
    const r = parseArgs('front_door --since 2h');
    expect(r.name).toBe('front_door');
    expect(r.since).toBeInstanceOf(Date);
    expect(r.count).toBeGreaterThan(20);
    expect(r.invalid).toBeUndefined();
  });

  it('flags invalid count', () => {
    expect(parseArgs('front_door 0').invalid).toBe('count');
    expect(parseArgs('front_door abc').invalid).toBe('count');
  });

  it('flags invalid duration', () => {
    expect(parseArgs('front_door --since 5x').invalid).toBe('duration');
    expect(parseArgs('front_door --since').invalid).toBe('duration');
  });
});

describe('logs.handler — parseDuration', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['7d', 7 * 86_400_000],
  ])('parses %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', '5', '5x', '-1h', '0h', undefined])('rejects %s', (input) => {
    expect(parseDuration(input)).toBeNull();
  });
});

describe('logs.handler — Return Home navigation', () => {
  it('appends cancel-pending Return Home to a localized sensor picker', async () => {
    const { handler } = createSetup();
    const ukContextWithEnabledSensors = commandContext('', 'uk');

    await handler.handleEmpty(ukContextWithEnabledSensors as never);

    const options = lastReplyOptions(ukContextWithEnabledSensors);
    expect(callbackData(options)).toEqual(['logs:front_door', 'rh:l:c']);
    expect(keyboardText(options)).toContain('🏠 Дім');
  });

  it('uses the English Return Home label when no locale catalog is present', async () => {
    const { handler } = createSetup();
    const ctx = commandContext('');

    await handler.handleEmpty(ctx as never);

    expect(keyboardText(lastReplyOptions(ctx))).toContain('🏠 Home');
  });

  it('adds terminal Return Home to inline and document deliveries', async () => {
    const { directLogsCallback, logs } = createSetup();
    const inlineContext = callbackContext('logs:front_door');
    logs.findRecent.mockResolvedValueOnce(inlineEntries);

    await directLogsCallback(inlineContext);

    expect(callbackData(lastReplyOptions(inlineContext as never))).toContain('rh:l:t');

    const documentContext = callbackContext('logs:front_door');
    logs.findRecent.mockResolvedValueOnce(entriesLongerThan4096);
    await directLogsCallback(documentContext);

    expect(documentContext.replyWithDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        caption: expect.stringContaining('Logs for front_door'),
        reply_markup: expect.anything(),
      }),
    );
    const documentOptions = documentContext.replyWithDocument.mock.calls[0][1];
    expect(callbackData(documentOptions)).toContain('rh:l:t');
  });

  it('adds terminal Return Home when no enabled sensors are available', async () => {
    const { handler, sensors } = createSetup();
    sensors.listEnabled.mockResolvedValueOnce([]);
    const ctx = commandContext('');

    await handler.handleEmpty(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(lastReplyOptions(ctx))).toContain('rh:l:t');
  });

  it.each([
    ['invalid count', 'front_door 0'],
    ['invalid duration', 'front_door --since 5x'],
  ])('adds terminal Return Home for %s', async (_label, match) => {
    const { commands } = createSetup();
    const ctx = commandContext(match);

    await commands.get('logs')?.(ctx);

    expect(callbackData(lastReplyOptions(ctx))).toContain('rh:l:t');
  });

  it('adds terminal Return Home when a command sensor is not found', async () => {
    const { commands, sensors } = createSetup();
    sensors.findByName.mockResolvedValueOnce(null);
    const ctx = commandContext('missing');

    await commands.get('logs')?.(ctx);

    expect(callbackData(lastReplyOptions(ctx))).toContain('rh:l:t');
  });

  it('adds terminal Return Home when a command has no logs', async () => {
    const { commands, logs } = createSetup();
    logs.findRecent.mockResolvedValueOnce([]);
    const ctx = commandContext('front_door');

    await commands.get('logs')?.(ctx);

    expect(callbackData(lastReplyOptions(ctx))).toContain('rh:l:t');
  });

  it('adds terminal Return Home when reading command logs fails', async () => {
    const { commands, sensors } = createSetup();
    sensors.findByName.mockRejectedValueOnce(new Error('database unavailable'));
    const ctx = commandContext('front_door');

    await commands.get('logs')?.(ctx);

    expect(callbackData(lastReplyOptions(ctx))).toContain('rh:l:t');
  });

  it('adds terminal Return Home when a selected sensor is not found', async () => {
    const { directLogsCallback, sensors } = createSetup();
    sensors.findByName.mockResolvedValueOnce(null);
    const ctx = callbackContext('logs:missing');

    await directLogsCallback(ctx);

    expect(callbackData(lastReplyOptions(ctx as never))).toContain('rh:l:t');
  });

  it('adds terminal Return Home when a selected sensor has no logs', async () => {
    const { directLogsCallback, logs } = createSetup();
    logs.findRecent.mockResolvedValueOnce([]);
    const ctx = callbackContext('logs:front_door');

    await directLogsCallback(ctx);

    expect(callbackData(lastReplyOptions(ctx as never))).toContain('rh:l:t');
  });

  it('adds terminal Return Home when reading selected sensor logs fails', async () => {
    const { directLogsCallback, sensors } = createSetup();
    sensors.findByName.mockRejectedValueOnce(new Error('database unavailable'));
    const ctx = callbackContext('logs:front_door');

    await directLogsCallback(ctx);

    expect(callbackData(lastReplyOptions(ctx as never))).toContain('rh:l:t');
  });
});

describe('logs.handler — direct sensor callback', () => {
  it('opens the alerting sensor recent logs from a logs callback', async () => {
    const { directLogsCallback, logs, sensors } = createSetup();
    sensors.findByIdIncludingArchived.mockResolvedValueOnce({
      kind: 'archived',
      sensor: { id: 'sensor-1', name: 'front_door', type: 'digital', archivedAt: new Date() },
    });
    const ctx = callbackContext('logs:id:sensor-1');
    logs.findRecent.mockResolvedValueOnce(inlineEntries);

    await directLogsCallback(ctx);

    expect(logs.findRecent).toHaveBeenCalledWith('sensor-1', { limit: 20 });
    expect(sensors.findByIdIncludingArchived).toHaveBeenCalledWith('sensor-1');
    expect(sensors.findByName).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toContain('Logs for front_door');
    expect(callbackData(lastReplyOptions(ctx as never))).toContain('rh:l:t');
  });
});
