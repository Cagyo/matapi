import { describe, expect, it, vi } from 'vitest';
import { UpdateGdriveAuthUseCase } from '../../../src/camera/application/update-gdrive-auth.use-case';
import { GdriveAuthFailedError } from '../../../src/camera/domain/errors/gdrive-auth-failed.error';
import { DriveAuthPort } from '../../../src/camera/domain/ports/drive-auth.port';
import { DriveQuota, DriveStatusPort } from '../../../src/camera/domain/ports/drive-status.port';

const QUOTA: DriveQuota = {
  totalBytes: 15 * 1024 ** 3,
  usedBytes: 8 * 1024 ** 3,
  freeBytes: 7 * 1024 ** 3,
};

describe('UpdateGdriveAuthUseCase', () => {
  it('updates config and verifies via about()', async () => {
    const auth: DriveAuthPort = {
      updateConfig: vi.fn().mockResolvedValue(undefined),
      restoreBackup: vi.fn().mockResolvedValue(undefined),
    };
    const status: DriveStatusPort = {
      about: vi.fn().mockResolvedValue(QUOTA),
    };

    const useCase = new UpdateGdriveAuthUseCase(auth, status);
    const result = await useCase.execute('[gdrive]\ntype = drive');

    expect(result).toEqual(QUOTA);
    expect(auth.updateConfig).toHaveBeenCalledWith('[gdrive]\ntype = drive');
    expect(status.about).toHaveBeenCalled();
    expect(auth.restoreBackup).not.toHaveBeenCalled();
  });

  it('restores backup and throws GdriveAuthFailedError if verification fails', async () => {
    const auth: DriveAuthPort = {
      updateConfig: vi.fn().mockResolvedValue(undefined),
      restoreBackup: vi.fn().mockResolvedValue(undefined),
    };
    const status: DriveStatusPort = {
      about: vi.fn().mockRejectedValue(new Error('invalid grant')),
    };

    const useCase = new UpdateGdriveAuthUseCase(auth, status);

    await expect(useCase.execute('[gdrive]\ntype = drive')).rejects.toThrow(
      GdriveAuthFailedError,
    );
    expect(auth.updateConfig).toHaveBeenCalled();
    expect(auth.restoreBackup).toHaveBeenCalled();
  });
});
