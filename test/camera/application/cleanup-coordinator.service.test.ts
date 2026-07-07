import { describe, expect, it, vi } from 'vitest';
import { CleanupCoordinatorService } from '../../../src/camera/application/cleanup-coordinator.service';
import { CleanupDriveUseCase } from '../../../src/camera/application/cleanup-drive.use-case';
import { CleanupLocalStorageUseCase } from '../../../src/camera/application/cleanup-local-storage.use-case';

function fakeCleanups() {
  const local = {
    execute: vi.fn(async (thresh?: number) => ({ thresholdUsed: thresh ?? 80 })),
  } as unknown as CleanupLocalStorageUseCase;

  const drive = {
    execute: vi.fn(async (thresh?: number) => ({ thresholdUsed: thresh ?? 80 })),
  } as unknown as CleanupDriveUseCase;

  return { local, drive };
}

describe('CleanupCoordinatorService', () => {
  it('executes local cleanup and returns result', async () => {
    const { local, drive } = fakeCleanups();
    const coordinator = new CleanupCoordinatorService(local, drive);

    expect(coordinator.isCleaning()).toBe(false);
    const res = await coordinator.runCleanup('local', 75);

    expect(res).toEqual({ executed: true, thresholdUsed: 75 });
    expect(local.execute).toHaveBeenCalledWith(75);
    expect(drive.execute).not.toHaveBeenCalled();
    expect(coordinator.isCleaning()).toBe(false);
  });

  it('executes drive cleanup and returns result', async () => {
    const { local, drive } = fakeCleanups();
    const coordinator = new CleanupCoordinatorService(local, drive);

    const res = await coordinator.runCleanup('drive', 85);

    expect(res).toEqual({ executed: true, thresholdUsed: 85 });
    expect(local.execute).not.toHaveBeenCalled();
    expect(drive.execute).toHaveBeenCalledWith(85);
  });

  it('executes both cleanups when target is both', async () => {
    const { local, drive } = fakeCleanups();
    const coordinator = new CleanupCoordinatorService(local, drive);

    const res = await coordinator.runCleanup('both', 80);

    expect(res).toEqual({ executed: true, thresholdUsed: 80 });
    expect(local.execute).toHaveBeenCalledWith(80);
    expect(drive.execute).toHaveBeenCalledWith(80);
  });

  it('prevents concurrent executions and returns executed: false', async () => {
    const { local, drive } = fakeCleanups();
    let resolveLocal!: () => void;
    const localPromise = new Promise<void>((resolve) => {
      resolveLocal = resolve;
    });
    local.execute = vi.fn(async () => {
      await localPromise;
      return { thresholdUsed: 80 };
    });

    const coordinator = new CleanupCoordinatorService(local, drive);

    const firstRun = coordinator.runCleanup('local', 80);
    expect(coordinator.isCleaning()).toBe(true);
    expect(coordinator.getActiveTarget()).toBe('local');

    const secondRun = await coordinator.runCleanup('both', 90);
    expect(secondRun).toEqual({ executed: false, thresholdUsed: 90 });
    expect(drive.execute).not.toHaveBeenCalled();

    resolveLocal();
    await firstRun;
    expect(coordinator.isCleaning()).toBe(false);
  });
});
