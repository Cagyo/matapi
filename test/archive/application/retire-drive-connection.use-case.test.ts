import { describe, expect, it, vi } from 'vitest';
import { RetireDriveConnectionUseCase } from '../../../src/archive/application/use-cases/retire-drive-connection.use-case';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { ArchiveRemoteMutationLockService } from '../../../src/archive/application/archive-remote-mutation-lock.service';

describe('RetireDriveConnectionUseCase', () => {
  it('serializes retirement through the shared remote mutation lock', async () => {
    const order: string[] = [];
    const credentials = {
      loadCredentials: vi.fn(async () => {
        order.push('credentials');
        return null;
      }),
      completeSecretRemoval: vi.fn(async () => { order.push('removed'); }),
    };
    const lock = new ArchiveRemoteMutationLockService();
    const exclusive = vi.spyOn(lock, 'runExclusive');
    const useCase = new RetireDriveConnectionUseCase(
      credentials as never,
      { revoke: vi.fn() },
      { now: () => new Date(1_700_000_000_000) },
      lock,
    );

    await useCase.execute(retiringConnection());

    expect(exclusive).toHaveBeenCalledOnce();
    expect(order).toEqual(['credentials', 'removed']);
  });

  it('removes old secrets even when revocation fails', async () => {
    const credentials = {
      loadCredentials: vi.fn().mockResolvedValue({ client: { clientId: 'id', clientSecret: 'secret' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiryDateMs: null, tokenType: null, scope: null }, revision: 2 }),
      completeSecretRemoval: vi.fn().mockResolvedValue(undefined),
    };
    const revoke = vi.fn().mockRejectedValue(new DriveTemporaryUnavailableError());
    const useCase = new RetireDriveConnectionUseCase(credentials as never, { revoke }, { now: () => new Date(1_700_000_000_000) });

    await useCase.execute(retiringConnection());

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(credentials.completeSecretRemoval)
      .toHaveBeenCalledWith('old-generation', 'retired_unmanaged', 1_700_000_000_000, 'DRIVE_TEMPORARY_UNAVAILABLE');
  });

  it('passes a bounded signal to its single revocation attempt', async () => {
    const credentials = {
      loadCredentials: vi.fn().mockResolvedValue({ client: { clientId: 'id', clientSecret: 'secret' }, tokens: { accessToken: 'access', refreshToken: 'refresh', expiryDateMs: null, tokenType: null, scope: null }, revision: 2 }),
      completeSecretRemoval: vi.fn().mockResolvedValue(undefined),
    };
    const revoke = vi.fn().mockResolvedValue(undefined);
    const caller = new AbortController().signal;
    const useCase = new RetireDriveConnectionUseCase(credentials as never, { revoke }, { now: () => new Date(1_700_000_000_000) });

    await useCase.execute(retiringConnection(), caller);

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(revoke.mock.calls[0][1]).not.toBe(caller);
  });
});

function retiringConnection(): DriveConnection {
  return DriveConnection.restore({
    id: 'old-generation', installationId: 'installation-1', status: 'retiring', revision: 2,
    permissionId: 'permission', email: null, displayName: null, folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' },
    createdAtMs: 1_600_000_000_000, updatedAtMs: 1_699_000_000_000, activatedAtMs: 1_600_000_000_000, retiredAtMs: null,
  });
}
