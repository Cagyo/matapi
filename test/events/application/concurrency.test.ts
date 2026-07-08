import { describe, expect, it } from 'vitest';
import { forEachWithConcurrency } from '../../../src/events/application/concurrency';

describe('forEachWithConcurrency', () => {
  it('processes every item', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let max = 0;
    await forEachWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(max).toBeLessThanOrEqual(3);
  });

  it('isolates per-item failures the callback catches', async () => {
    const results: string[] = [];
    await forEachWithConcurrency([1, 2, 3], 2, async (n) => {
      try {
        if (n === 2) throw new Error('boom');
        results.push(`ok${n}`);
      } catch {
        results.push(`fail${n}`);
      }
    });
    expect(results.sort()).toEqual(['fail2', 'ok1', 'ok3']);
  });
});
