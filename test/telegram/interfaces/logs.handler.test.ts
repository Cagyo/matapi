import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  parseDuration,
} from '../../../src/telegram/interfaces/logs.handler';

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
    expect(parseDuration(input as string | undefined)).toBeNull();
  });
});
