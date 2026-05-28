import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemClockAdapter } from '../../../src/events/infrastructure/system-clock.adapter';

describe('SystemClockAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the current system time', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(new SystemClockAdapter().now()).toEqual(now);
  });
});