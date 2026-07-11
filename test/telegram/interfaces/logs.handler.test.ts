import { describe, expect, it, vi } from 'vitest';
import {
  LogsHandler,
  parseArgs,
  parseDuration,
} from '../../../src/telegram/interfaces/logs.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

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

describe('logs.handler — direct sensor callback', () => {
  it('opens the alerting sensor recent logs from a logs callback', async () => {
    const sensors = {
      listEnabled: vi.fn(),
      findById: vi.fn(),
      findByIdIncludingArchived: vi.fn().mockResolvedValue({
        kind: 'archived',
        sensor: { id: 'sensor-1', name: 'front_door', archivedAt: new Date() },
      }),
      findByName: vi.fn(),
    } as any;
    const logs = {
      findRecent: vi.fn().mockResolvedValue([
        { timestamp: new Date('2026-07-11T08:00:00Z'), level: 'warn', message: 'Alarm triggered' },
      ]),
    } as any;
    const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
    const handler = new LogsHandler(sensors, logs, guard);
    let callback: ((ctx: any) => Promise<void>) | undefined;
    handler.register({
      command: vi.fn(),
      callbackQuery: vi.fn((_regex, _middleware, fn) => {
        callback = fn;
      }),
    } as any);
    const ctx = {
      from: { id: 1 },
      callbackQuery: { data: 'logs:id:sensor-1' },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply: vi.fn().mockResolvedValue(true),
    };

    await callback?.(ctx);

    expect(logs.findRecent).toHaveBeenCalledWith('sensor-1', { limit: 20 });
    expect(sensors.findByIdIncludingArchived).toHaveBeenCalledWith('sensor-1');
    expect(sensors.findByName).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Logs for front_door'));
  });
});
