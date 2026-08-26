import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { en } from '../../../src/locales/en';
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
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';

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
const activeReceipt = {
  ...receipt,
  id: 'qrstuvwxyzabcdef',
} satisfies WorkflowReturnReceipt;

type Handler = (ctx: Record<string, unknown>, next?: () => Promise<void>) => Promise<void>;

function setup(availability?: FeatureAvailabilityPort) {
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
    // Retracting, not merely forgetting: ending a source prompt is Telegram
    // I/O, so every supersession path awaits it.
    retractPending: vi.fn().mockResolvedValue(undefined),
    handleEntry: vi.fn(),
    handleCallback: vi.fn(),
    handleText: vi.fn().mockResolvedValue(false),
    hasPending: vi.fn().mockReturnValue(false),
  };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const drafts = { register: vi.fn() };
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
    drafts as never,
    navigation as unknown as WorkflowNavigationHandler,
    availability,
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
    drafts,
    handler,
    navigation,
    open,
    snapshot,
    sources,
    text: text!,
    workflows,
  };
}

/**
 * Readiness per feature, not one blanket answer: the RTSP Sources entry is
 * gated on `rtsp` alone, so a port whose `requireReady` ignored its argument
 * could not tell the visibility matrix apart.
 */
function readiness(ready: Partial<Record<'motion' | 'rtsp', boolean>>): FeatureAvailabilityPort {
  return {
    awaitInitialVerification: vi.fn(),
    inspect: vi.fn(),
    requireReady: vi.fn(async (name: string) => {
      if (ready[name as 'motion' | 'rtsp']) return;
      throw new FeatureUnavailableError(name as 'motion' | 'rtsp', 'needs-attention');
    }),
  };
}

function context(
  input: { match?: string; data?: string; text?: string; role?: 'admin' | 'user'; chatType?: string } = {},
) {
  return {
    from: { id: 7 },
    chat: { id: 11, type: input.chatType ?? 'private' },
    match: input.match ?? '',
    message: { message_id: 20, text: input.text ?? '/camera' },
    callbackQuery: input.data ? { data: input.data } : undefined,
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 7, role: input.role ?? 'admin' },
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

function buttonLabels(ctx: ReturnType<typeof context>): string[] {
  return (ctx.reply.mock.calls as unknown[][]).flatMap((call) => {
    const options = call[1];
    if (!isRecord(options) || !isRecord(options.reply_markup) || !Array.isArray(options.reply_markup.inline_keyboard))
      return [];
    return options.reply_markup.inline_keyboard.flatMap((row) =>
      Array.isArray(row)
        ? row.flatMap((button) => (isRecord(button) && typeof button.text === 'string' ? [button.text] : []))
        : [],
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/*
 * RTSP Sources is administrator-only and appears only while RTSP is ready, so
 * all four cells of that matrix are asserted rather than the one happy path.
 */
describe('camera dashboard RTSP Sources visibility', () => {
  const label = catalogFor('en').camera.sources.dashboardButton;
  const entry = 'cam:abcdefghijklmnop:src';

  it('offers the entry to an administrator while RTSP is ready, after Live', async () => {
    const { handler } = setup(readiness({ motion: true, rtsp: true }));
    const ctx = context();

    await handler.handleDashboard(ctx as never, { receipt });

    expect(buttonLabels(ctx)).toContain(label);
    expect(callbacks(ctx)).toContain(entry);
    // Live stays the first camera action.
    expect(buttonLabels(ctx)[0]).toBe(catalogFor('en').camera.dashboardButtons.live);
    expect(callbacks(ctx).every((data) => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);
  });

  it('hides the entry from an administrator while RTSP is not ready', async () => {
    const { handler } = setup(readiness({ motion: true, rtsp: false }));
    const ctx = context();

    await handler.handleDashboard(ctx as never, { receipt });

    expect(buttonLabels(ctx)).not.toContain(label);
    expect(callbacks(ctx)).not.toContain(entry);
    expect(buttonLabels(ctx)[0]).toBe(catalogFor('en').camera.dashboardButtons.live);
  });

  it('hides the entry from a normal user while RTSP is ready', async () => {
    const { handler } = setup(readiness({ motion: true, rtsp: true }));
    const ctx = context({ role: 'user' });

    await handler.handleDashboard(ctx as never, { receipt });

    expect(buttonLabels(ctx)).not.toContain(label);
    expect(callbacks(ctx)).not.toContain(entry);
  });

  it('hides the entry from a normal user while RTSP is not ready', async () => {
    const { handler } = setup(readiness({ motion: true, rtsp: false }));
    const ctx = context({ role: 'user' });

    await handler.handleDashboard(ctx as never, { receipt });

    expect(buttonLabels(ctx)).not.toContain(label);
    expect(callbacks(ctx)).not.toContain(entry);
  });

  it('opens the Sources screen from the dashboard entry under the same receipt', async () => {
    const { callback, handler, sources } = setup(readiness({ motion: true, rtsp: true }));
    await handler.handleDashboard(context() as never, { receipt });

    await callback(context({ data: entry }));

    expect(sources.handleEntry).toHaveBeenCalledWith(expect.anything(), { receipt });
    expect(sources.handleCallback).not.toHaveBeenCalled();
  });
});

describe('/camera sources direct entry', () => {
  it('routes a private administrator command to the Sources screen', async () => {
    const { commands, sources } = setup(readiness({ motion: true, rtsp: true }));
    const ctx = context({ match: 'sources' });

    await commands.get('camera')!(ctx);

    expect(sources.handleEntry).toHaveBeenCalledWith(ctx, { receipt });
  });

  it('never opens the Sources screen outside a private chat', async () => {
    const { commands, sources, workflows } = setup(readiness({ motion: true, rtsp: true }));

    await commands.get('camera')!(context({ match: 'sources', chatType: 'group' }));

    expect(sources.handleEntry).not.toHaveBeenCalled();
    expect(workflows.begin).not.toHaveBeenCalled();
  });

  /*
   * The role and readiness gates live in CameraSourcesHandler, so the command
   * path reaches exactly the same entry point the dashboard button does —
   * which is what makes the two paths impossible to gate differently.
   */
  it('delegates the administrator and readiness gates to the same entry point as the dashboard', async () => {
    const { callback, commands, handler, sources } = setup(readiness({ motion: true, rtsp: true }));
    await handler.handleDashboard(context() as never, { receipt });
    await callback(context({ data: 'cam:abcdefghijklmnop:src' }));
    await commands.get('camera')!(context({ match: 'sources', role: 'user' }));

    expect(sources.handleEntry).toHaveBeenCalledTimes(2);
    for (const call of sources.handleEntry.mock.calls) {
      expect(call[1]).toEqual({ receipt });
    }
  });
});

describe('camera contextual callbacks', () => {
  it('starts direct camera commands from Home and preserves a captured launch receipt', async () => {
    const { handler, workflows } = setup();
    const ctx = context();
    await handler.handleDashboard(ctx as never, { receipt });

    expect(callbacks(ctx)).toEqual(
      expect.arrayContaining([
        'cam:abcdefghijklmnop:l',
        'cam:abcdefghijklmnop:b',
        'wr:abcdefghijklmnop:o',
        'wr:abcdefghijklmnop:h',
      ]),
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

  it('marks live-stream work running and keeps the opened watch link in the leave-running workflow', async () => {
    const { callback, handler, navigation, open, workflows } = setup();
    const dashboard = context();
    await handler.handleDashboard(dashboard as never, { receipt });
    const live = context({ data: 'cam:abcdefghijklmnop:l' });

    await callback(live);

    expect(workflows.markRunning).toHaveBeenCalledWith(live, receipt);
    expect(callbacks(live)).toEqual(expect.arrayContaining([
      'wr:abcdefghijklmnop:o',
      'wr:abcdefghijklmnop:h',
    ]));
    expect(navigation.complete).not.toHaveBeenCalled();
    expect(open.execute).toHaveBeenCalledWith({ telegramId: 7, cameraName: undefined });
  });

  it('routes receipt-bound source actions only after validation', async () => {
    const { callback, handler, sources } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    const source = context({ data: 'cam:abcdefghijklmnop:src:a' });

    await callback(source);

    expect(sources.handleCallback).toHaveBeenCalledWith(source, 'a', receipt);
  });

  it('clears browse input before a source callback can claim the next text message', async () => {
    const { callback, handler, sources, text } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    await callback(context({ data: 'cam:abcdefghijklmnop:bp' }));
    await callback(context({ data: 'cam:abcdefghijklmnop:src:a' }));
    const input = context({ text: '08.04.2026' });
    const next = vi.fn().mockResolvedValue(undefined);

    await text(input, next);

    expect(sources.handleCallback).toHaveBeenCalledWith(expect.anything(), 'a', receipt);
    expect(next).toHaveBeenCalledOnce();
    expect(input.reply).not.toHaveBeenCalledWith(en.camera.browse.timeRangePrompt('08.04.2026'), expect.anything());
  });

  it('clears the exact source prompt when a browse callback starts', async () => {
    const { callback, handler, sources } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    await callback(context({ data: 'cam:abcdefghijklmnop:src:a' }));

    await callback(context({ data: 'cam:abcdefghijklmnop:b' }));

    expect(sources.retractPending).toHaveBeenCalledWith(7, 11, receipt.id);
  });

  it('clears source input before invoking a root camera operation', async () => {
    const { callback, handler, snapshot, sources } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    await callback(context({ data: 'cam:abcdefghijklmnop:src:a' }));

    await callback(context({ data: 'cam:abcdefghijklmnop:s' }));

    expect(sources.retractPending).toHaveBeenCalledWith(7, 11, receipt.id);
    expect(sources.retractPending.mock.invocationCallOrder[0]).toBeLessThan(
      snapshot.execute.mock.invocationCallOrder[0],
    );
  });

  it('localizes a stale Motion callback without marking the workflow running', async () => {
    const availability: FeatureAvailabilityPort = {
      awaitInitialVerification: vi.fn(), inspect: vi.fn(),
      requireReady: vi.fn().mockRejectedValue(new FeatureUnavailableError('motion', 'installed-off')),
    };
    const { callback, handler, snapshot, workflows } = setup(availability);
    await handler.handleDashboard(context() as never, { receipt });
    const ctx = context({ data: 'cam:abcdefghijklmnop:s' });

    await callback(ctx);

    expect(snapshot.execute).not.toHaveBeenCalled();
    expect(workflows.markRunning).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.stale.disabled(catalogFor('en').feature.names.motion));
  });

  it('uses the active non-English catalog for stale callbacks', async () => {
    const availability: FeatureAvailabilityPort = {
      awaitInitialVerification: vi.fn(), inspect: vi.fn(),
      requireReady: vi.fn().mockRejectedValue(new FeatureUnavailableError('motion', 'needs-attention')),
    };
    const { callback, handler, workflows } = setup(availability);
    const dashboard = context();
    dashboard.localeState.catalog = catalogFor('uk');
    await handler.handleDashboard(dashboard as never, { receipt });
    const ctx = context({ data: 'cam:abcdefghijklmnop:s' });
    ctx.localeState.catalog = catalogFor('uk');

    await callback(ctx);

    expect(workflows.markRunning).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('uk').feature.stale.attention(catalogFor('uk').feature.names.motion));
  });

  it('preserves browse results while navigating within the browse workflow', async () => {
    const { callback, handler, navigation } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    (handler as unknown as { results: Map<string, unknown> }).results.set(
      '7:11:abcdefghijklmnop',
      {
        receipt,
        events: [{
          id: 9,
          cameraId: 'front',
          cameraName: 'Front door',
          startedAt: new Date('2026-07-17T12:00:00Z'),
          endedAt: new Date('2026-07-17T12:01:00Z'),
          videoPath: '/tmp/9.mp4',
          snapshotPath: null,
          uploadedToGdrive: false,
          gdriveFileId: null,
          localDeleted: false,
        }],
        header: 'Browse results',
        createdAtMs: Date.now(),
      },
    );
    const browseBack = context({ data: 'cam:abcdefghijklmnop:br' });

    await callback(browseBack);

    expect(navigation.complete).not.toHaveBeenCalled();
    expect(browseBack.reply).toHaveBeenCalledWith(expect.stringContaining('Browse results'), {
      reply_markup: expect.anything(),
    });
  });

  it('uses the active receipt browse input after a newer Camera entry replaces a stale prompt', async () => {
    const { callback, handler, sources, text, workflows } = setup();
    await handler.handleDashboard(context() as never, { receipt });
    await callback(context({ data: 'cam:abcdefghijklmnop:bp' }));
    await handler.handleDashboard(context() as never, { receipt: activeReceipt });
    await callback(context({ data: 'cam:qrstuvwxyzabcdef:bp' }));
    workflows.validateCurrent.mockImplementation(async (_ctx, candidate) => candidate.id === activeReceipt.id);
    const input = context({ text: '08.04.2026' });
    const next = vi.fn().mockResolvedValue(undefined);

    await text(input, next);

    expect(sources.handleText).toHaveBeenCalledWith(input);
    expect(workflows.validateCurrent).toHaveBeenLastCalledWith(input, activeReceipt);
    expect(input.reply).toHaveBeenCalledWith(en.camera.browse.timeRangePrompt('08.04.2026'), {
      reply_markup: expect.anything(),
    });
    expect(next).not.toHaveBeenCalled();
  });

  /*
   * `CameraSourcesHandler.hasPending` is the only thing that can tell Camera a
   * draft exists when Camera itself holds none, and the answer decides whether
   * the workflow's Back raises `common.interrupted`. Both arms are pinned
   * because the Sources screen widened what "pending" means: viewing the
   * overview now counts, where only an in-flight prompt used to.
   */
  it('treats a live Sources screen as a cancellable Camera draft', async () => {
    const { handler, sources } = setup();
    sources.hasPending.mockReturnValue(true);

    await expect(handler.cancelExact({ userId: 7, chatId: 11, receiptId: receipt.id })).resolves.toBe('cancelled');

    expect(sources.hasPending).toHaveBeenCalledWith(7, 11, receipt.id);
  });

  it('reports a missing draft when neither Camera nor the Sources screen holds one', async () => {
    const { handler, sources } = setup();
    sources.hasPending.mockReturnValue(false);

    await expect(handler.cancelExact({ userId: 7, chatId: 11, receiptId: receipt.id })).resolves.toBe('missing');
  });

  it('registers an exact Camera draft canceller for returned source and browse state', async () => {
    const { drafts, handler, sources } = setup();
    await handler.handleDashboard(context() as never, { receipt });

    await expect(handler.cancelExact({ userId: 7, chatId: 11, receiptId: receipt.id })).resolves.toBe('cancelled');

    expect(drafts.register).toHaveBeenCalledWith('camera', handler);
    expect(sources.retractPending).toHaveBeenCalledWith(7, 11, receipt.id);
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

/*
 * ─── Superseding a workflow ends its prompts, it does not forget them ──────
 *
 * A fresh receipt evicts the older one's state, and an RTSP source prompt is
 * part of that state — but a prompt is an armed ForceReply sitting in the chat,
 * so forgetting its routing strands it: the credential replied into it reaches
 * the next handler undeleted. Ending one is Telegram I/O, which is why every
 * path here awaits the retraction rather than calling a synchronous forget.
 */
describe('CameraHandler retracts superseded source prompts', () => {
  it('retracts every open prompt when a new receipt supersedes an older one', async () => {
    const { commands, sources, workflows } = setup(readiness({ motion: true, rtsp: true }));
    await commands.get('camera')!(context());
    sources.retractPending.mockClear();
    workflows.begin.mockResolvedValue(activeReceipt);

    // `/camera` again: the ordinary way an armed address prompt was orphaned.
    await commands.get('camera')!(context());

    expect(sources.retractPending).toHaveBeenCalledWith(7, 11, undefined);
  });

  it('retracts before the superseding screen is rendered, never after', async () => {
    const { commands, handler, sources, workflows } = setup(readiness({ motion: true, rtsp: true }));
    await commands.get('camera')!(context());
    sources.retractPending.mockClear();
    sources.handleEntry.mockClear();
    workflows.begin.mockResolvedValue(activeReceipt);

    await handler.handleDashboard(context() as never, { receipt: activeReceipt });
    await commands.get('camera')!(context({ match: 'sources' }));

    expect(sources.retractPending).toHaveBeenCalled();
    expect(sources.retractPending.mock.invocationCallOrder[0]).toBeLessThan(
      sources.handleEntry.mock.invocationCallOrder[0],
    );
  });
});
