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
});
