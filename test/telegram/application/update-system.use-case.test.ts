import { describe, expect, it, vi } from 'vitest';
import { UpdateSystemUseCase } from '../../../src/telegram/application/update-system.use-case';
import { OtaPort, UpdateCheck } from '../../../src/system/domain/ports/ota.port';
import { UpdateInProgressError } from '../../../src/system/domain/errors/update-in-progress.error';

function makeOta(
  overrides: Partial<OtaPort> = {},
): OtaPort {
  return {
    isLocked: async () => false,
    checkForUpdates: async (): Promise<UpdateCheck> => ({
      hasUpdates: true,
      localCommit: 'aaa1111',
      remoteCommit: 'bbb2222',
    }),
    startUpdate: vi.fn().mockResolvedValue(undefined),
    startRollback: async () => {},
    ...overrides,
  };
}

describe('UpdateSystemUseCase', () => {
  it('returns up-to-date and skips spawn when no remote changes', async () => {
    const ota = makeOta({
      checkForUpdates: async () => ({
        hasUpdates: false,
        localCommit: 'aaa',
        remoteCommit: 'aaa',
      }),
    });
    const useCase = new UpdateSystemUseCase(ota);

    expect(await useCase.execute()).toEqual({ kind: 'up-to-date' });
    expect(ota.startUpdate).not.toHaveBeenCalled();
  });

  it('starts the update and returns the remote commit', async () => {
    const ota = makeOta();
    const useCase = new UpdateSystemUseCase(ota);

    expect(await useCase.execute()).toEqual({
      kind: 'started',
      commit: 'bbb2222',
    });
    expect(ota.startUpdate).toHaveBeenCalledOnce();
  });

  it('refuses to start when an update is already in progress', async () => {
    const ota = makeOta({ isLocked: async () => true });
    const useCase = new UpdateSystemUseCase(ota);

    await expect(useCase.execute()).rejects.toBeInstanceOf(
      UpdateInProgressError,
    );
    expect(ota.startUpdate).not.toHaveBeenCalled();
  });
});
