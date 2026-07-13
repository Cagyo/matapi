import { describe, expect, it, vi } from 'vitest';
import { BrowseMotionEventsUseCase } from '../../../src/camera/application/browse-motion-events.use-case';
import { CameraStatusUseCase } from '../../../src/camera/application/camera-status.use-case';
import { DisableMotionUseCase } from '../../../src/camera/application/disable-motion.use-case';
import { EnableMotionUseCase } from '../../../src/camera/application/enable-motion.use-case';
import { GetMotionPhotoUseCase } from '../../../src/camera/application/get-motion-photo.use-case';
import { GetMotionVideoUseCase } from '../../../src/camera/application/get-motion-video.use-case';
import { GetSnapshotUseCase } from '../../../src/camera/application/get-snapshot.use-case';
import { ListMotionEventsUseCase } from '../../../src/camera/application/list-motion-events.use-case';
import { OpenLiveStreamUseCase } from '../../../src/camera/application/open-live-stream.use-case';
import { StopLiveStreamUseCase } from '../../../src/camera/application/stop-live-stream.use-case';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';
import { LiveStreamExpiredError } from '../../../src/camera/domain/errors/live-stream-expired.error';
import { LiveStreamSourceUnavailableError } from '../../../src/camera/domain/errors/live-stream-source-unavailable.error';
import { LiveStreamUnavailableError } from '../../../src/camera/domain/errors/live-stream-unavailable.error';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { en } from '../../../src/locales/en';
import { ru } from '../../../src/locales/ru';
import {
  buildBrowseRange,
  CameraHandler,
  formatBrowseDateLabel,
  parseBrowseDateInput,
  parseTimeRangeInput,
} from '../../../src/telegram/interfaces/camera.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';

describe('camera browse input parsers', () => {
  it('parses DD.MM.YYYY dates and rejects impossible dates', () => {
    expect(parseBrowseDateInput('08.04.2026')).toEqual({
      ok: true,
      date: new Date(2026, 3, 8),
      dateLabel: '08.04.2026',
    });
    expect(parseBrowseDateInput('31.02.2026')).toEqual({ ok: false });
    expect(parseBrowseDateInput('2026-04-08')).toEqual({ ok: false });
  });

  it('parses canonical time ranges and whitespace around the hyphen', () => {
    expect(parseTimeRangeInput('18:00-23:00')).toEqual({
      ok: true,
      startHour: 18,
      startMinute: 0,
      endHour: 23,
      endMinute: 0,
      label: '18:00-23:00',
    });
    expect(parseTimeRangeInput('18:00 - 23:00')).toEqual({
      ok: true,
      startHour: 18,
      startMinute: 0,
      endHour: 23,
      endMinute: 0,
      label: '18:00-23:00',
    });
  });

  it('rejects malformed, shorthand, impossible, zero-length, and overnight ranges', () => {
    expect(parseTimeRangeInput('8-9')).toEqual({ ok: false, reason: 'format' });
    expect(parseTimeRangeInput('24:00-25:00')).toEqual({ ok: false, reason: 'format' });
    expect(parseTimeRangeInput('18:60-19:00')).toEqual({ ok: false, reason: 'format' });
    expect(parseTimeRangeInput('18:00-18:00')).toEqual({ ok: false, reason: 'order' });
    expect(parseTimeRangeInput('23:00-01:00')).toEqual({ ok: false, reason: 'order' });
  });

  it('builds local Date boundaries with inclusive start and exclusive end semantics', () => {
    const parsed = parseTimeRangeInput('18:00-23:00');
    if (!parsed.ok) throw new Error('expected valid range');

    expect(formatBrowseDateLabel(new Date(2026, 3, 8))).toBe('08.04.2026');
    expect(buildBrowseRange(new Date(2026, 3, 8), parsed)).toEqual({
      start: new Date(2026, 3, 8, 18, 0),
      end: new Date(2026, 3, 8, 23, 0),
      rangeLabel: '18:00-23:00',
    });
  });
});

function event(overrides: Partial<MotionEvent> = {}): MotionEvent {
  return {
    id: 42,
    cameraId: 'front_door',
    startedAt: new Date('2026-04-08T12:51:06'),
    endedAt: new Date('2026-04-08T12:51:36'),
    videoPath: '/motion/42.mp4',
    snapshotPath: '/motion/42.jpg',
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
    ...overrides,
  };
}

function createTestSetup() {
  const snapshot = { execute: vi.fn() } as unknown as GetSnapshotUseCase;
  const listEvents = { execute: vi.fn() } as unknown as ListMotionEventsUseCase;
  const browse = {
    latest: vi.fn(async () => ({ events: [event()], hasMore: false })),
    between: vi.fn(async () => ({ events: [event()], hasMore: false })),
  } as unknown as BrowseMotionEventsUseCase;
  const video = { execute: vi.fn() } as unknown as GetMotionVideoUseCase;
  const photo = { execute: vi.fn() } as unknown as GetMotionPhotoUseCase;
  const enable = { execute: vi.fn() } as unknown as EnableMotionUseCase;
  const disable = { execute: vi.fn() } as unknown as DisableMotionUseCase;
  const status = { execute: vi.fn() } as unknown as CameraStatusUseCase;
  const registerMessageReference = vi.fn().mockResolvedValue(undefined);
  const open = {
    execute: vi.fn().mockResolvedValue({
      watchUrl: 'https://clear-moon.trycloudflare.com/watch/secret-token',
      remainingMs: 300_000,
      expiresMonotonicMs: 300_000,
      cameraName: 'front_door',
      registerMessageReference,
    }),
    executeById: vi.fn().mockResolvedValue({
      watchUrl: 'https://clear-moon.trycloudflare.com/watch/secret-token',
      remainingMs: 300_000,
      expiresMonotonicMs: 300_000,
      cameraName: 'front_door',
      registerMessageReference,
    }),
  } as unknown as OpenLiveStreamUseCase;
  const stop = {
    execute: vi.fn().mockResolvedValue('front_door'),
  } as unknown as StopLiveStreamUseCase;
  const sessions = {
    revokeUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as LiveStreamSessionService;
  const guard = {
    registered: vi.fn(),
    resolveRole: vi.fn().mockResolvedValue('user'),
  } as unknown as RoleMiddleware;
  const sources = {
    handleEntry: vi.fn().mockResolvedValue(undefined),
    handleCallback: vi.fn().mockResolvedValue(undefined),
    handleText: vi.fn().mockResolvedValue(false),
  } as unknown as CameraSourcesHandler;

  const handler = new CameraHandler(
    snapshot,
    listEvents,
    browse,
    video,
    photo,
    enable,
    disable,
    status,
    open,
    stop,
    sessions,
    guard,
    sources,
  );

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
    on: vi.fn((name, middleware, fn) => {
      messageCallbacks[name] = fn || middleware;
    }),
  } as any;

  handler.register(composer);

  return {
    handler,
    browse,
    open,
    stop,
    sessions,
    guard,
    sources,
    registerMessageReference,
    composer,
    commandCallbacks,
    callbackQueryCallbacks,
    messageCallbacks,
  };
}

describe('CameraHandler source delegation', () => {
  it('keeps one camera command owner and delegates the sources subcommand', async () => {
    const { composer, commandCallbacks, sources } = createTestSetup();
    const request = ctx();
    request.match = 'sources';

    await commandCallbacks.camera(request);

    expect(composer.command).toHaveBeenCalledTimes(1);
    expect(sources.handleEntry).toHaveBeenCalledWith(request);
  });

  it('delegates source callbacks and pending text through CameraHandler', async () => {
    const { callbackQueryCallbacks, messageCallbacks, sources } = createTestSetup();
    const callback = ctx('cam:sources:list');
    await callbackQueryCallbacks[0].fn(callback);
    expect(sources.handleCallback).toHaveBeenCalledWith(callback, 'list');

    vi.mocked(sources.handleText).mockResolvedValueOnce(true);
    const text = ctx();
    text.message = { text: 'Front door' };
    const next = vi.fn();
    await messageCallbacks['message:text'](text, next);
    expect(sources.handleText).toHaveBeenCalledWith(text);
    expect(next).not.toHaveBeenCalled();
  });
});

function ctx(data?: string) {
  return {
    from: { id: 100 },
    chat: { id: 42, type: 'private' },
    callbackQuery: data ? { data } : undefined,
    message: data ? undefined : { text: '/camera' },
    match: '',
    reply: vi.fn().mockResolvedValue({ message_id: 9 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
  };
}

describe('CameraHandler experimental live stream', () => {
  it('opens a registered command request with a normal URL button and registers the sent message', async () => {
    const { commandCallbacks, open, stop, sessions, registerMessageReference } = createTestSetup();
    const context = ctx();
    context.match = 'live front_door';

    await commandCallbacks.camera(context);

    expect(open.execute).toHaveBeenCalledWith({
      telegramId: 100,
      cameraName: 'front_door',
    });
    expect(context.reply).toHaveBeenNthCalledWith(1, en.camera.live.opening);
    expect(context.reply).toHaveBeenNthCalledWith(
      2,
      en.camera.live.opened(5),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify(context.reply.mock.calls[1][1].reply_markup)).toContain(
      'https://clear-moon.trycloudflare.com/watch/secret-token',
    );
    expect(registerMessageReference).toHaveBeenCalledWith({ chatId: 42, messageId: 9 });
    expect(context.api.deleteMessage).not.toHaveBeenCalled();
    expect(sessions.revokeUser).not.toHaveBeenCalled();
    expect(stop.execute).not.toHaveBeenCalled();
  });

  it('resolves a motion-alert callback camera id through the open use case and answers the query', async () => {
    const { callbackQueryCallbacks, open } = createTestSetup();
    const context = ctx('cam:live:front_door');

    await callbackQueryCallbacks[0].fn(context);

    expect(context.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(open.executeById).toHaveBeenCalledWith({
      telegramId: 100,
      cameraId: 'front_door',
    });
  });

  it('continues safely when Telegram cannot acknowledge the callback query', async () => {
    const { callbackQueryCallbacks, open } = createTestSetup();
    const context = ctx('cam:live:front_door');
    context.answerCallbackQuery.mockRejectedValueOnce(new Error('query expired'));

    await callbackQueryCallbacks[0].fn(context);

    expect(open.executeById).toHaveBeenCalledWith({
      telegramId: 100,
      cameraId: 'front_door',
    });
  });

  it('opens the default camera from the dashboard without placing a source in callback data', async () => {
    const { commandCallbacks, callbackQueryCallbacks, open } = createTestSetup();
    const dashboard = ctx();

    await commandCallbacks.camera(dashboard);

    const keyboard = JSON.stringify(dashboard.reply.mock.calls[0][1].reply_markup);
    expect(keyboard).toContain('cam:live');
    expect(keyboard).not.toContain('trycloudflare.com');

    await callbackQueryCallbacks[0].fn(ctx('cam:live'));
    expect(open.execute).toHaveBeenCalledWith({ telegramId: 100, cameraName: undefined });
  });

  it('stops the shared stream and distinguishes no active session', async () => {
    const { commandCallbacks, stop } = createTestSetup();
    const stopped = ctx();
    stopped.match = 'stop_stream';

    await commandCallbacks.camera(stopped);

    expect(stop.execute).toHaveBeenCalledWith(100);
    expect(stopped.reply).toHaveBeenCalledWith(en.camera.live.stopped);

    (stop.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const inactive = ctx();
    inactive.match = 'stop_stream';
    await commandCallbacks.camera(inactive);
    expect(inactive.reply).toHaveBeenCalledWith(en.camera.live.noActive);
  });

  it('maps live failures through the registered user locale without exposing diagnostics', async () => {
    const { commandCallbacks, open } = createTestSetup();
    const context = ctx() as ReturnType<typeof ctx> & { localeState: unknown };
    context.match = 'live';
    context.localeState = {
      user: { telegramId: 100, name: 'User', role: 'user', locale: 'ru' },
      locale: 'ru',
      catalog: ru,
    };
    (open.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new LiveStreamSourceUnavailableError(),
    );

    await commandCallbacks.camera(context);

    expect(context.reply).toHaveBeenLastCalledWith(ru.camera.live.sourceUnavailable);
    expect(JSON.stringify(context.reply.mock.calls)).not.toContain('secret-token');
  });

  it('deletes the sent URL and revokes the viewer when message registration fails', async () => {
    const { commandCallbacks, stop, sessions, registerMessageReference } = createTestSetup();
    registerMessageReference.mockRejectedValueOnce(new LiveStreamUnavailableError());
    const context = ctx();
    context.match = 'live';

    await commandCallbacks.camera(context);

    expect(context.api.deleteMessage).toHaveBeenCalledWith(42, 9);
    expect(sessions.revokeUser).toHaveBeenCalledWith(100);
    expect(context.api.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      (sessions.revokeUser as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(stop.execute).not.toHaveBeenCalled();
    expect(context.reply).toHaveBeenLastCalledWith(en.camera.live.unavailable);
  });

  it('contains watch-message deletion failure and still revokes the viewer', async () => {
    const { commandCallbacks, sessions, registerMessageReference } = createTestSetup();
    registerMessageReference.mockRejectedValueOnce(new LiveStreamUnavailableError());
    const context = ctx();
    context.match = 'live';
    context.api.deleteMessage.mockRejectedValueOnce(new Error('message missing'));

    await commandCallbacks.camera(context);

    expect(sessions.revokeUser).toHaveBeenCalledWith(100);
    expect(context.reply).toHaveBeenLastCalledWith(en.camera.live.unavailable);
  });

  it('stops the shared stream when viewer revocation fails', async () => {
    const { commandCallbacks, stop, sessions, registerMessageReference } = createTestSetup();
    registerMessageReference.mockRejectedValueOnce(new LiveStreamUnavailableError());
    (sessions.revokeUser as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new LiveStreamUnavailableError(),
    );
    const context = ctx();
    context.match = 'live';

    await commandCallbacks.camera(context);

    expect(context.api.deleteMessage).toHaveBeenCalledWith(42, 9);
    expect(stop.execute).toHaveBeenCalledWith(100);
    expect((sessions.revokeUser as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((stop.execute as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(context.reply).toHaveBeenLastCalledWith(en.camera.live.unavailable);
  });

  it('does not open live view without complete private message context', async () => {
    const cases = [
      { from: undefined },
      { chat: undefined },
      { message: undefined },
      { chat: { id: -42, type: 'group' } },
    ];

    for (const missing of cases) {
      const { commandCallbacks, open } = createTestSetup();
      const context = Object.assign(ctx(), missing);
      context.match = 'live';
      await commandCallbacks.camera(context);
      expect(open.execute).not.toHaveBeenCalled();
    }
  });

  it('answers but does not open an inline or non-private callback without chat context', async () => {
    for (const chat of [undefined, { id: -42, type: 'group' }]) {
      const { callbackQueryCallbacks, open } = createTestSetup();
      const context = ctx('cam:live:front_door');
      context.chat = chat as never;
      await callbackQueryCallbacks[0].fn(context);
      expect(context.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(open.executeById).not.toHaveBeenCalled();
    }
  });

  it('registers command and callback paths behind the registered-user guard', () => {
    const { composer, guard } = createTestSetup();

    expect(composer.command).toHaveBeenCalledWith(
      'camera',
      guard.registered,
      expect.any(Function),
    );
    expect(composer.callbackQuery).toHaveBeenCalledWith(
      /^cam:/,
      guard.registered,
      expect.any(Function),
    );
  });

  it('maps an expired live request to the synchronized locale key', async () => {
    const { commandCallbacks, open } = createTestSetup();
    (open.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new LiveStreamExpiredError(),
    );
    const context = ctx();
    context.match = 'live';

    await commandCallbacks.camera(context);

    expect(context.reply).toHaveBeenLastCalledWith(en.camera.live.expired);
  });
});

describe('CameraHandler browse menu and input flow', () => {
  it('adds Browse Events to the dashboard keyboard', async () => {
    const { commandCallbacks } = createTestSetup();
    const context = ctx();

    await commandCallbacks.camera(context);

    expect(context.reply).toHaveBeenCalledWith(
      expect.stringContaining('Camera Dashboard'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify(context.reply.mock.calls[0][1].reply_markup)).toContain('cam:browse');
  });

  it('opens the Browse Events menu from callback', async () => {
    const { callbackQueryCallbacks } = createTestSetup();
    const context = ctx('cam:browse');

    await callbackQueryCallbacks[0].fn(context);

    expect(context.reply).toHaveBeenCalledWith(
      expect.stringContaining('Browse Motion Events'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    const keyboard = JSON.stringify(context.reply.mock.calls[0][1].reply_markup);
    expect(keyboard).toContain('« Back');
    expect(keyboard).toContain('❌ Close');
  });

  it('runs Latest 20 without pending typed input', async () => {
    const { callbackQueryCallbacks, browse } = createTestSetup();
    const context = ctx('cam:browse:latest');

    await callbackQueryCallbacks[0].fn(context);

    expect(browse.latest).toHaveBeenCalledTimes(1);
    expect(context.reply).toHaveBeenCalledWith(
      expect.stringContaining('Latest Motion Events'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('asks for a time range after Today, then searches the typed range with a concrete date header', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-08T10:00:00'));
      const { callbackQueryCallbacks, messageCallbacks, browse } = createTestSetup();

      await callbackQueryCallbacks[0].fn(ctx('cam:browse:today'));

      const textCtx = ctx();
      textCtx.message = { text: '18:00 - 23:00' };
      await messageCallbacks['message:text'](textCtx, vi.fn());

      expect(browse.between).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
      );
      const [start, end] = (browse.between as any).mock.calls[0];
      expect(start.getHours()).toBe(18);
      expect(end.getHours()).toBe(23);
      expect(textCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Events for 08.04.2026'),
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for a date, rejects invalid input, then advances to time range prompt', async () => {
    const { callbackQueryCallbacks, messageCallbacks } = createTestSetup();
    await callbackQueryCallbacks[0].fn(ctx('cam:browse:pick-date'));

    const invalid = ctx();
    invalid.message = { text: '31.02.2026' };
    await messageCallbacks['message:text'](invalid, vi.fn());
    expect(invalid.reply).toHaveBeenCalledWith(expect.stringContaining('DD.MM.YYYY'));

    const valid = ctx();
    valid.message = { text: '08.04.2026' };
    await messageCallbacks['message:text'](valid, vi.fn());
    expect(valid.reply).toHaveBeenCalledWith(
      expect.stringContaining('Send the time range for 08.04.2026.'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('keeps awaiting a range after malformed and overnight inputs', async () => {
    const { callbackQueryCallbacks, messageCallbacks, browse } = createTestSetup();
    await callbackQueryCallbacks[0].fn(ctx('cam:browse:yesterday'));

    const malformed = ctx();
    malformed.message = { text: '8-9' };
    await messageCallbacks['message:text'](malformed, vi.fn());
    expect(malformed.reply).toHaveBeenCalledWith(expect.stringContaining('HH:MM-HH:MM'));

    const overnight = ctx();
    overnight.message = { text: '23:00-01:00' };
    await messageCallbacks['message:text'](overnight, vi.fn());
    expect(overnight.reply).toHaveBeenCalledWith(expect.stringContaining('Overnight ranges'));
    expect(browse.between).not.toHaveBeenCalled();
  });
});
