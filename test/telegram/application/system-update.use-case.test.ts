import { describe, expect, it, vi } from 'vitest';
import { SystemUpdateUseCase } from '../../../src/telegram/application/system-update.use-case';
import {
  SystemDepsCheck,
  SystemDepsPort,
} from '../../../src/system/domain/ports/system-deps.port';

function makeDeps(overrides: Partial<SystemDepsPort> = {}): SystemDepsPort {
  return {
    check: async (): Promise<SystemDepsCheck> => ({
      deps: [{ name: 'motion', current: '4.5.1', available: '4.6.0', kind: 'upgrade' }],
      hasUpdates: true,
      nodeMajorMismatch: false,
    }),
    applyUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SystemUpdateUseCase', () => {
  it('delegates check() to the port', async () => {
    const deps = makeDeps();
    const useCase = new SystemUpdateUseCase(deps);

    const result = await useCase.check();

    expect(result.hasUpdates).toBe(true);
    expect(result.deps).toHaveLength(1);
  });

  it('delegates apply() to the port', async () => {
    const deps = makeDeps();
    const useCase = new SystemUpdateUseCase(deps);

    await useCase.apply();

    expect(deps.applyUpdate).toHaveBeenCalledOnce();
  });

  it('propagates a check failure', async () => {
    const deps = makeDeps({
      check: async () => {
        throw new Error('apt update failed');
      },
    });
    const useCase = new SystemUpdateUseCase(deps);

    await expect(useCase.check()).rejects.toThrow('apt update failed');
  });
});
