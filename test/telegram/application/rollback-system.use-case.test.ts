import { describe, expect, it, vi } from 'vitest';
import { RollbackSystemUseCase } from '../../../src/telegram/application/rollback-system.use-case';
import { OtaPort } from '../../../src/system/domain/ports/ota.port';
import { UpdateInProgressError } from '../../../src/system/domain/errors/update-in-progress.error';
import { NoRollbackTagError } from '../../../src/system/domain/errors/no-rollback-tag.error';

function makeOta(
  overrides: Partial<OtaPort> = {},
): OtaPort {
  return {
    isLocked: async () => false,
    checkForUpdates: async () => ({
      hasUpdates: false,
      localCommit: '',
      remoteCommit: '',
    }),
    startUpdate: async () => {},
    startRollback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('RollbackSystemUseCase', () => {
  it('starts the rollback script', async () => {
    const ota = makeOta();
    const useCase = new RollbackSystemUseCase(ota);

    await useCase.execute();

    expect(ota.startRollback).toHaveBeenCalledOnce();
  });

  it('refuses to start when an update is already in progress', async () => {
    const ota = makeOta({ isLocked: async () => true });
    const useCase = new RollbackSystemUseCase(ota);

    await expect(useCase.execute()).rejects.toBeInstanceOf(
      UpdateInProgressError,
    );
    expect(ota.startRollback).not.toHaveBeenCalled();
  });

  it('propagates NoRollbackTagError from the adapter', async () => {
    const ota = makeOta({
      startRollback: vi
        .fn()
        .mockRejectedValue(new NoRollbackTagError()) as OtaPort['startRollback'],
    });
    const useCase = new RollbackSystemUseCase(ota);

    await expect(useCase.execute()).rejects.toBeInstanceOf(NoRollbackTagError);
  });
});
