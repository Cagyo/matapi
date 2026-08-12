import { Logger } from '@nestjs/common';
import { InputFile } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { ApplicationLogUnavailableError } from '../../../src/system/domain/errors/application-log-unavailable.error';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import {
  classifyLogsCommand,
  LogsHandler,
  parseArgs,
  parseDuration,
} from '../../../src/telegram/interfaces/logs.handler';
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
  const readApplicationLogs = {
    execute: vi.fn().mockResolvedValue({
      stream: 'output',
      lines: ['oldest', 'newest'],
      truncatedByByteLimit: false,
    }),
  };
  const applicationDocuments = {
    render: vi.fn().mockReturnValue({
      filename: 'application_logs_2026-08-12_17-05-06.txt',
      caption: 'application caption',
      content: Buffer.from('oldest\nnewest\n'),
    }),
  };
  const guard = {
    registered: vi.fn(),
    adminOnly: vi.fn(async (ctx: ReturnType<typeof context>, next: () => Promise<void>) => {
      if (ctx.localeState.user.role === 'admin') await next();
      else await ctx.reply(ctx.localeState.catalog.common.adminRequired);
    }),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
    }),
  };
  const handler = new LogsHandler(
    sensors as never,
    logs as never,
    guard as unknown as RoleMiddleware,
    workflows as unknown as WorkflowEntryCoordinator,
    readApplicationLogs as never,
    applicationDocuments as never,
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
    applicationDocuments,
    guard,
    handler,
    logs,
    navigation,
    readApplicationLogs,
    sensors,
    workflows,
  };
}

function context(input: {
  match?: string;
  callback?: string;
  role?: 'user' | 'admin';
} = {}) {
  return {
    from: { id: 1 },
    chat: { id: 1, type: 'private' },
    match: input.match ?? '',
    callbackQuery: input.callback ? { data: input.callback } : undefined,
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 1, role: input.role ?? 'user' },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function callbackData(ctx: ReturnType<typeof context>): string[] {
  const keyboard = ctx.reply.mock.calls[0]?.[1]?.reply_markup as
    | { inline_keyboard?: { callback_data?: string }[][] }
    | undefined;
  return keyboard?.inline_keyboard?.flat().flatMap((button) => button.callback_data ?? []) ?? [];
}

describe('logs.handler parsing', () => {
  it.each([
    ['app', { kind: 'application', stream: 'output' }],
    [' APP ', { kind: 'application', stream: 'output' }],
    ['error', { kind: 'application', stream: 'error' }],
    ['error 50', { kind: 'application-invalid' }],
    ['app --since 1h', { kind: 'application-invalid' }],
    ['sensor app 50', { kind: 'sensor', raw: 'app 50' }],
    ['sensor error --since 2h', { kind: 'sensor', raw: 'error --since 2h' }],
    ['sensor', { kind: 'sensor', raw: 'sensor' }],
    ['front_door 20', { kind: 'sensor', raw: 'front_door 20' }],
  ])('classifies %j', (raw, expected) => {
    expect(classifyLogsCommand(raw)).toEqual(expected);
  });

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

  it('rejects a non-admin before workflow or application-log access', async () => {
    const { commands, workflows, readApplicationLogs, sensors } = setup();
    const ctx = context({ match: 'app', role: 'user' });

    await commands.get('logs')?.(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(ctx.localeState.catalog.common.adminRequired);
    expect(workflows.begin).not.toHaveBeenCalled();
    expect(readApplicationLogs.execute).not.toHaveBeenCalled();
    expect(sensors.findByName).not.toHaveBeenCalled();
  });

  it.each([
    ['app', 'output'],
    ['error', 'error'],
  ] as const)('delivers %s through the receipt-bound document path', async (match, stream) => {
    const { commands, navigation, readApplicationLogs, applicationDocuments } = setup();
    const ctx = context({ match, role: 'admin' });
    readApplicationLogs.execute.mockResolvedValue({
      stream,
      lines: ['line'],
      truncatedByByteLimit: false,
    });

    await commands.get('logs')?.(ctx);

    expect(readApplicationLogs.execute).toHaveBeenCalledWith(stream);
    expect(applicationDocuments.render).toHaveBeenCalledWith(
      ctx.localeState.catalog,
      expect.objectContaining({ stream }),
    );
    expect(navigation.complete).toHaveBeenCalledWith(
      ctx,
      { receipt },
      expect.objectContaining({ effectStage: 'pending' }),
    );
    expect(ctx.replyWithDocument).toHaveBeenCalledWith(
      expect.any(InputFile),
      { caption: 'application caption' },
    );
    expect(ctx.replyWithDocument).toHaveBeenCalledOnce();
  });

  it.each([
    [[], false],
    [['newest'], true],
  ] as const)('always delivers a document for lines=%j truncated=%s', async (lines, truncated) => {
    const { commands, readApplicationLogs } = setup();
    const ctx = context({ match: 'app', role: 'admin' });
    readApplicationLogs.execute.mockResolvedValue({
      stream: 'output',
      lines,
      truncatedByByteLimit: truncated,
    });

    await commands.get('logs')?.(ctx);

    expect(ctx.replyWithDocument).toHaveBeenCalledOnce();
  });

  it('maps a typed reader failure to localized safe copy', async () => {
    const { commands, readApplicationLogs } = setup();
    const ctx = context({ match: 'error', role: 'admin' });
    readApplicationLogs.execute.mockRejectedValue(
      new ApplicationLogUnavailableError('stream-path-invalid'),
    );

    await commands.get('logs')?.(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(ctx.localeState.catalog.logs.application.unavailable);
    expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain('stream-path-invalid');
  });

  it.each(['app 50', 'error --since 1h'])(
    'rejects reserved extra arguments without sensor lookup',
    async (match) => {
      const { commands, sensors, readApplicationLogs } = setup();
      const ctx = context({ match, role: 'admin' });

      await commands.get('logs')?.(ctx);

      expect(sensors.findByName).not.toHaveBeenCalled();
      expect(readApplicationLogs.execute).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        ctx.localeState.catalog.logs.application.invalidArguments,
      );
    },
  );

  it.each(['sensor app', 'sensor error'])('uses the explicit sensor escape for %s', async (match) => {
    const { commands, sensors, logs, readApplicationLogs } = setup();
    const ctx = context({ match, role: 'user' });

    await commands.get('logs')?.(ctx);

    expect(sensors.findByName).toHaveBeenCalledWith(match.split(' ')[1]);
    expect(logs.findRecent).toHaveBeenCalled();
    expect(readApplicationLogs.execute).not.toHaveBeenCalled();
  });

  it('re-authorizes a Home launch and does not begin a second workflow', async () => {
    const { handler, workflows, guard, navigation, readApplicationLogs } = setup();
    const ctx = context({ role: 'admin' });

    await handler.handleApplication(ctx as never, 'error', { receipt });

    expect(guard.adminOnly).toHaveBeenCalled();
    expect(workflows.begin).not.toHaveBeenCalled();
    expect(readApplicationLogs.execute).toHaveBeenCalledWith('error');
    expect(navigation.complete).toHaveBeenCalledWith(
      ctx,
      { receipt },
      expect.objectContaining({ effectStage: 'pending' }),
    );
  });

  it('does not copy an unexpected secret-bearing error into Nest logs or replies', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { commands, readApplicationLogs } = setup();
    const ctx = context({ match: 'app', role: 'admin' });
    readApplicationLogs.execute.mockRejectedValue(new Error('secret /raw/log/path'));

    await commands.get('logs')?.(ctx);

    expect(logError).toHaveBeenCalledWith('/logs application-log retrieval failed');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret /raw/log/path');
    expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain('secret /raw/log/path');
  });

  it('delegates document failure recovery to workflow navigation without retrying', async () => {
    const { commands, navigation } = setup();
    const ctx = context({ match: 'app', role: 'admin' });
    ctx.replyWithDocument.mockRejectedValue(new Error('Telegram unavailable'));
    navigation.complete.mockImplementation(async (_ctx, _launch, presentation) => {
      await presentation.deliver().catch(() => undefined);
    });

    await commands.get('logs')?.(ctx);

    expect(ctx.replyWithDocument).toHaveBeenCalledOnce();
    expect(navigation.complete).toHaveBeenCalledOnce();
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
        'wr:abcdefghijklmnop:h',
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
