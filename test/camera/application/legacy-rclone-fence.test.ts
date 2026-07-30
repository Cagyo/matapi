import { describe, expect, it, vi } from 'vitest';
import { UploadMotionUseCase } from '../../../src/camera/application/upload-motion.use-case';
import { CleanupDriveUseCase } from '../../../src/camera/application/cleanup-drive.use-case';

describe('legacy rclone compatibility fence', () => {
  it('does not bulk-upload Motion files through the legacy scheduler', async () => {
    const drive = { copyMotionFiles: vi.fn() };
    const useCase = new UploadMotionUseCase(
      { findPendingUploads: vi.fn() } as never, {} as never, drive as never,
      {} as never, {} as never, {} as never,
    );

    await useCase.execute();

    expect(drive.copyMotionFiles).not.toHaveBeenCalled();
  });

  it('does not prune Drive objects through the legacy cleanup path', async () => {
    const drive = { pruneMotionFiles: vi.fn() };
    const useCase = new CleanupDriveUseCase(
      { about: vi.fn() } as never, drive as never, {} as never, {} as never,
    );

    await useCase.execute();

    expect(drive.pruneMotionFiles).not.toHaveBeenCalled();
  });
});
