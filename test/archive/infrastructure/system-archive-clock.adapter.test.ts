import { describe, expect, it } from 'vitest';
import { SystemArchiveClockAdapter } from '../../../src/archive/infrastructure/system-archive-clock.adapter';

describe('SystemArchiveClockAdapter', () => {
  it('combines the existing synchronization probe with a plausible wall clock', async () => {
    const adapter = new SystemArchiveClockAdapter(
      { probe: async () => ({ synchronized: true, offsetMs: 25 }) },
      { now: () => Date.UTC(2030, 0, 1) },
    );

    await expect(adapter.read()).resolves.toEqual({
      nowMs: Date.UTC(2030, 0, 1),
      synchronized: true,
      plausible: true,
      offsetMs: 25,
    });
  });

  it.each([
    ['before the plausible floor', Date.UTC(2019, 11, 31, 23, 59, 59, 999)],
    ['at the implausible ceiling', Date.UTC(2100, 0, 1)],
  ])('marks wall time %s unhealthy', async (_condition, nowMs) => {
    const adapter = new SystemArchiveClockAdapter(
      { probe: async () => ({ synchronized: true, offsetMs: null }) },
      { now: () => nowMs },
    );

    await expect(adapter.read()).resolves.toMatchObject({
      nowMs,
      synchronized: true,
      plausible: false,
    });
  });

  it('marks an excessive reported offset implausible without hiding synchronization state', async () => {
    const adapter = new SystemArchiveClockAdapter(
      { probe: async () => ({ synchronized: true, offsetMs: 5 * 60 * 1_000 + 1 }) },
      { now: () => Date.UTC(2030, 0, 1), maxOffsetMs: 5 * 60 * 1_000 },
    );

    await expect(adapter.read()).resolves.toEqual({
      nowMs: Date.UTC(2030, 0, 1),
      synchronized: true,
      plausible: false,
      offsetMs: 5 * 60 * 1_000 + 1,
    });
  });

  it('fails closed when the synchronization probe reports malformed offset data', async () => {
    const adapter = new SystemArchiveClockAdapter(
      { probe: async () => ({ synchronized: true, offsetMs: Number.NaN }) },
      { now: () => Date.UTC(2030, 0, 1) },
    );

    await expect(adapter.read()).resolves.toMatchObject({
      synchronized: false,
      plausible: false,
    });
  });
});
