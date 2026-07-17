import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import {
  buildBrowseRange,
  CameraHandler,
  formatBrowseDateLabel,
  parseBrowseDateInput,
  parseTimeRangeInput,
} from '../../../src/telegram/interfaces/camera.handler';
import { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 7,
  chatId: 11,
  kind: 'workflow-return',
  sessionToken: 'home-token',
  status: 'pending',
  expiresAt: new Date('2030-01-01'),
  payload: {
    workflow: 'camera',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'sensors', page: 2 },
  },
} satisfies WorkflowReturnReceipt;

type Handler = (ctx: Record<string, unknown>, next?: () => Promise<void>) => Promise<void>;

function setup() {
  const snapshot = {
    execute: vi.fn().mockResolvedValue({
      buffer: Buffer.from('x'),
      cameraName: 'Front',
      takenAt: new Date(),
    }),
  };
  const listEvents = { execute: vi.fn().mockResolvedValue([]) };
  const browse = {
    latest: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
    between: vi.fn().mockResolvedValue({ events: [], hasMore: false }),
  };
  const video = { execute: vi.fn() };
  const photo = { execute: vi.fn() };
  const enable = { execute: vi.fn() };
  const disable = { execute: vi.fn() };
  const status = { execute: vi.fn().mockResolvedValue({}) };
  const open = {
    execute: vi.fn().mockResolvedValue({
      watchUrl: 'https://example.test/secret',
      remainingMs: 60_000,
      registerMessageReference: vi.fn(),
    }),
    executeById: vi.fn(),
  };
  const stop = { execute: vi.fn() };
  const sessions = { revokeUser: vi.fn() };
  const sources = {
    cancelPending: vi.fn(),
    handleEntry: vi.fn(),
    handleCallback: vi.fn(),
    handleText: vi.fn().mockResolvedValue(false),
  };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
    }),
  };
  const handler = new CameraHandler(
    snapshot as never,
    listEvents as never,
    browse as never,
    video as never,
    photo as never,
    enable as never,
    disable as never,
    status as never,
    open as never,
    stop as never,
    sessions as never,
    { registered: vi.fn() } as unknown as RoleMiddleware,
    sources as unknown as CameraSourcesHandler,
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
  );
  const commands = new Map<string, Handler>();
  let callback: Handler | undefined;
  let text: Handler | undefined;
  handler.register({
    command: vi.fn((name: string, _guard: unknown, fn: Handler) => commands.set(name, fn)),
    callbackQuery: vi.fn((_filter: RegExp, _guard: unknown, fn: Handler) => {
      callback = fn;
    }),
    on: vi.fn((_kind: string, _guard: unknown, fn: Handler) => {
      text = fn;
    }),
  } as never);
  return {
    callback: callback!,
    commands,
    handler,
    navigation,
    open,
    snapshot,
    sources,
    text: text!,
    workflows,
  };
}

function context(input: { match?: string; data?: string; text?: string } = {}) {
  return {
    from: { id: 7 },
    chat: { id: 11, type: 'private' },
    match: input.match ?? '',
    message: { message_id: 20, text: input.text ?? '/camera' },
    callbackQuery: input.data ? { data: input.data } : undefined,
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 7, role: 'admin' },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue({ message_id: 55 }),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    replyWithPhoto: vi.fn().mockResolvedValue(true),
    replyWithVideo: vi.fn().mockResolvedValue(true),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  };
}

function callbacks(ctx: ReturnType<typeof context>): string[] {
  return (ctx.reply.mock.calls as unknown[][]).flatMap((call) => callbackData(call[1]));
}

function callbackData(options: unknown): string[] {
  if (!isRecord(options) || !isRecord(options.reply_markup) || !Array.isArray(options.reply_markup.inline_keyboard))
    return [];
  return options.reply_markup.inline_keyboard.flatMap((row) =>
    Array.isArray(row)
      ? row.flatMap((button) =>
          isRecord(button) && typeof button.callback_data === 'string' ? [button.callback_data] : [],
        )
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('camera contextual callbacks', () => {
  it('starts direct camera commands from Home and preserves a captured launch receipt', async () => {
    const { handler, workflows } = setup();
    const ctx = context();
    await handler.handleDashboard(ctx as never, { receipt });

    expect(callbacks(ctx)).toEqual(
      expect.arrayContaining(['cam:abcdefghijklmnop:l', 'cam:abcdefghijklmnop:b', 'wr:abcdefghijklmnop:o']),
    );
    expect(callbacks(ctx).every((data) => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);
    expect(workflows.begin).not.toHaveBeenCalled();
  });

  it('validates the exact receipt before a dashboard callback invokes a camera effect', async () => {
    const { callback, handler, snapshot, workflows } = setup();
    const dashboard = context();
    await handler.handleDashboard(dashboard as never, { receipt });
    workflows.validateCurrent.mockResolvedValueOnce(false);
    const stale = context({ data: 'cam:abcdefghijklmnop:s' });

    await callback(stale);

    expect(workflows.validateCurrent).toHaveBeenCalledWith(stale, receipt);
    expect(snapshot.execute).not.toHaveBeenCalled();
  });

  it('marks live-stream work running, keeps Return Home available, and sends a result through completion', async () => {
    const { callback, handler, navigation, workflows } = setup();
    const dashboard = context();
    await handler.handleDashboard(dashboard as never, { receipt });
    const live = context({ data: 'cam:abcdefghijklmnop:l' });

    await callback(live);

    expect(workflows.markRunning).toHaveBeenCalledWith(live, receipt);
    expect(callbacks(live)).toContain('wr:abcdefghijklmnop:o');
    expect(navigation.complete).toHaveBeenCalledWith(
      live,
      { receipt },
      expect.objectContaining({ effectStage: 'pending' }),
    );
  });

  it('routes receipt-bound source actions only after validation', async () => {
    const { callback, handler, sources } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    const source = context({ data: 'cam:abcdefghijklmnop:src:a' });

    await callback(source);

    expect(sources.handleCallback).toHaveBeenCalledWith(source, 'a', receipt);
  });
});

describe('camera browse parsers', () => {
  it('parses valid date and time inputs', () => {
    expect(parseBrowseDateInput('08.04.2026')).toEqual({
      ok: true,
      date: new Date(2026, 3, 8),
      dateLabel: '08.04.2026',
    });
    expect(parseBrowseDateInput('31.02.2026')).toEqual({ ok: false });
    expect(parseTimeRangeInput('18:00 - 23:00')).toMatchObject({
      ok: true,
      label: '18:00-23:00',
    });
    expect(parseTimeRangeInput('23:00-01:00')).toEqual({
      ok: false,
      reason: 'order',
    });
    const parsed = parseTimeRangeInput('18:00-23:00');
    if (!parsed.ok) throw new Error('expected range');
    expect(formatBrowseDateLabel(new Date(2026, 3, 8))).toBe('08.04.2026');
    expect(buildBrowseRange(new Date(2026, 3, 8), parsed)).toEqual({
      start: new Date(2026, 3, 8, 18),
      end: new Date(2026, 3, 8, 23),
      rangeLabel: '18:00-23:00',
    });
  });
});
