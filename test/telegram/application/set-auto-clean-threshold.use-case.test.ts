import { describe, expect, it } from 'vitest';
import { SetAutoCleanThresholdUseCase } from '../../../src/telegram/application/set-auto-clean-threshold.use-case';

describe('SetAutoCleanThresholdUseCase', () => {
  it('uses only the 70/75/80/85/90 whitelist and falls back for malformed stored values', async () => {
    const values = new Map<string, string>([['auto_clean_threshold', 'wat']]);
    const useCase = new SetAutoCleanThresholdUseCase({
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value); },
      delete: async () => undefined,
    });

    await expect(useCase.current()).resolves.toBe(80);
    await expect(useCase.execute(85)).resolves.toBe(85);
    await expect(useCase.execute(73 as never)).rejects.toThrow(RangeError);
  });

  it('uses the existing environment fallback when the persisted threshold is outside the whitelist', async () => {
    const prior = process.env.DISK_CRITICAL_PERCENT;
    process.env.DISK_CRITICAL_PERCENT = '85';
    try {
      const useCase = new SetAutoCleanThresholdUseCase({
        get: async () => '73', set: async () => undefined, delete: async () => undefined,
      });
      await expect(useCase.current()).resolves.toBe(85);
    } finally {
      if (prior === undefined) delete process.env.DISK_CRITICAL_PERCENT;
      else process.env.DISK_CRITICAL_PERCENT = prior;
    }
  });

  it('uses the environment fallback when reading metadata fails', async () => {
    const prior = process.env.DISK_CRITICAL_PERCENT;
    process.env.DISK_CRITICAL_PERCENT = '90';
    try {
      const useCase = new SetAutoCleanThresholdUseCase({
        get: async () => { throw new Error('database unavailable'); },
        set: async () => undefined,
        delete: async () => undefined,
      });
      await expect(useCase.current()).resolves.toBe(90);
    } finally {
      if (prior === undefined) delete process.env.DISK_CRITICAL_PERCENT;
      else process.env.DISK_CRITICAL_PERCENT = prior;
    }
  });
});
