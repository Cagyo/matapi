import { describe, expect, it, vi } from 'vitest';
import { BrowseMotionEventsUseCase } from '../../../src/camera/application/browse-motion-events.use-case';
import { CameraStatusUseCase } from '../../../src/camera/application/camera-status.use-case';
import { DisableMotionUseCase } from '../../../src/camera/application/disable-motion.use-case';
import { EnableMotionUseCase } from '../../../src/camera/application/enable-motion.use-case';
import { GetMotionPhotoUseCase } from '../../../src/camera/application/get-motion-photo.use-case';
import { GetMotionVideoUseCase } from '../../../src/camera/application/get-motion-video.use-case';
import { GetSnapshotUseCase } from '../../../src/camera/application/get-snapshot.use-case';
import { ListMotionEventsUseCase } from '../../../src/camera/application/list-motion-events.use-case';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import {
  buildBrowseRange,
  CameraHandler,
  formatBrowseDateLabel,
  parseBrowseDateInput,
  parseTimeRangeInput,
} from '../../../src/telegram/interfaces/camera.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

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
  const guard = {
    registered: vi.fn(),
    resolveRole: vi.fn().mockResolvedValue('user'),
  } as unknown as RoleMiddleware;

  const handler = new CameraHandler(
    snapshot,
    listEvents,
    browse,
    video,
    photo,
    enable,
    disable,
    status,
    guard,
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
    composer,
    commandCallbacks,
    callbackQueryCallbacks,
    messageCallbacks,
  };
}

function ctx(data?: string) {
  return {
    from: { id: 100 },
    callbackQuery: data ? { data } : undefined,
    message: undefined as { text: string } | undefined,
    match: '',
    reply: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
  };
}

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
