import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { LogsHandler, parseArgs, parseDuration } from '../../../src/telegram/interfaces/logs.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 1,
  chatId: 1,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-01'),
  payload: {
    workflow: 'logs',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'history' },
  },
} satisfies WorkflowReturnReceipt;

const sensor = {
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
const entries = [
  {
    sensorId: sensor.id,
    timestamp: new Date('2026-07-11T08:00:00Z'),
    level: 'warn' as const,
    message: 'Alarm triggered',
  },
];

type Handler = (ctx: Record<string, unknown>) => Promise<void>;

function setup() {
  const sensors = {
    listEnabled: vi.fn().mockResolvedValue([sensor]),
    findByIdIncludingArchived: vi.fn().mockResolvedValue({ kind: 'active', sensor }),
    findByName: vi.fn().mockResolvedValue({ kind: 'active', sensor }),
  };
  const logs = { findRecent: vi.fn().mockResolvedValue(entries) };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
    }),
  };
  const handler = new LogsHandler(
    sensors as never,
    logs as never,
    { registered: vi.fn() } as unknown as RoleMiddleware,
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
  );
  const commands = new Map<string, Handler>();
  let callback: Handler | undefined;
  handler.register({
    command: vi.fn((name: string, _guard: unknown, fn: Handler) => commands.set(name, fn)),
    callbackQuery: vi.fn((_filter: RegExp, _guard: unknown, fn: Handler) => {
      callback = fn;
    }),
  } as never);
  return {
    callback: callback!,
    commands,
    handler,
    logs,
    navigation,
    sensors,
    workflows,
  };
}

function context(input: { match?: string; callback?: string } = {}) {
  return {
    from: { id: 1 },
    chat: { id: 1, type: 'private' },
    match: input.match ?? '',
    callbackQuery: input.callback ? { data: input.callback } : undefined,
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 1, role: 'user' },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

function callbackData(ctx: ReturnType<typeof context>): string[] {
  const keyboard = ctx.reply.mock.calls[0]?.[1]?.reply_markup as
    | { inline_keyboard?: { callback_data?: string }[][] }
    | undefined;
  return keyboard?.inline_keyboard?.flat().flatMap((button) => button.callback_data ?? []) ?? [];
}

describe('logs.handler parsing', () => {
  it('parses count and duration arguments', () => {
    expect(parseArgs('front_door 50')).toMatchObject({
      name: 'front_door',
      count: 50,
    });
    expect(parseArgs('front_door --since 2h')).toMatchObject({
      name: 'front_door',
      count: 1000,
    });
    expect(parseArgs('front_door 0').invalid).toBe('count');
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('bad')).toBeNull();
  });
});

describe('logs.handler contextual navigation', () => {
  it('starts direct commands from History and completes through the captured receipt', async () => {
    const { commands, navigation, workflows } = setup();
    const ctx = context({ match: 'front_door 5' });

    await commands.get('logs')?.(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'logs', {
      source: 'natural-parent',
    });
    expect(navigation.complete).toHaveBeenCalledWith(
      ctx,
      { receipt },
      expect.objectContaining({ effectStage: 'pending' }),
    );
    expect(ctx.reply.mock.calls[0][0]).toContain('Logs for front_door');
  });

  it('binds picker buttons to a receipt-scoped opaque selector under Telegram limits', async () => {
    const { handler } = setup();
    const ctx = context();

    await handler.handleEmpty(ctx as never, { receipt });

    const data = callbackData(ctx);
    expect(data).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^logs:abcdefghijklmnop:s:[A-Za-z0-9_-]{12}$/),
        'wr:abcdefghijklmnop:o',
      ]),
    );
    expect(data.every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);
  });

  it('rejects a stale picker receipt before sensor lookup or local-state consumption', async () => {
    const { callback, handler, sensors, workflows } = setup();
    const picker = context();
    await handler.handleEmpty(picker as never, { receipt });
    workflows.validateCurrent.mockResolvedValueOnce(false);
    const stale = context({
      callback: callbackData(picker).find((data) => data.startsWith('logs:'))!,
    });

    await callback(stale);

    expect(workflows.validateCurrent).toHaveBeenCalledWith(stale, receipt);
    expect(sensors.findByIdIncludingArchived).not.toHaveBeenCalled();
    expect(stale.reply).not.toHaveBeenCalled();
  });

  it('validates the current receipt before resolving a selected sensor and restores once', async () => {
    const { callback, handler, logs, navigation, sensors, workflows } = setup();
    const picker = context();
    await handler.handleEmpty(picker as never, { receipt });
    const selected = context({
      callback: callbackData(picker).find((data) => data.startsWith('logs:'))!,
    });

    await callback(selected);

    expect(workflows.validateCurrent).toHaveBeenCalledWith(selected, receipt);
    expect(sensors.findByIdIncludingArchived).toHaveBeenCalledWith('sensor-1');
    expect(logs.findRecent).toHaveBeenCalledWith('sensor-1', { limit: 20 });
    expect(navigation.complete).toHaveBeenCalledTimes(1);
  });
});
