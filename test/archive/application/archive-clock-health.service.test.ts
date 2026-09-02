import { describe, expect, it, vi } from 'vitest';
import { ArchiveClockHealthService } from '../../../src/archive/application/archive-clock-health.service';
import type { ArchiveSchedulerUpdate } from '../../../src/archive/application/ports/archive-artifact-repository.port';
import { ArchiveWakeService } from '../../../src/archive/application/archive-wake.service';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';

describe('ArchiveClockHealthService', () => {
  it('keeps the exact five-minute rollback boundary healthy without rebasing the baseline earlier', async () => {
    const { repository, service } = await setup({ lastPlausibleWallTimeMs: 1_000_000 });

    await expect(service.check(700_000)).resolves.toBe('healthy');
    await expect(repository.readSchedulerState()).resolves.toMatchObject({
      lastPlausibleWallTimeMs: 1_000_000,
      clockHealth: 'healthy',
      observedRollbackMs: null,
    });
  });

  it('blocks a rollback one millisecond beyond the five-minute tolerance', async () => {
    const { repository, service } = await setup({ lastPlausibleWallTimeMs: 1_000_000 });

    await expect(service.check(699_999)).resolves.toBe('clock-blocked');
    await expect(repository.readSchedulerState()).resolves.toMatchObject({
      clockHealth: 'clock-blocked',
      lastPlausibleWallTimeMs: 1_000_000,
      observedRollbackMs: 300_001,
    });
  });

  it('retains the maximum observed rollback throughout a sustained block', async () => {
    const { repository, service } = await setup({ lastPlausibleWallTimeMs: 1_000_000 });

    await expect(service.check(650_000)).resolves.toBe('clock-blocked');
    await expect(service.check(500_000)).resolves.toBe('clock-blocked');
    await expect(service.check(600_000)).resolves.toBe('clock-blocked');

    await expect(repository.readSchedulerState()).resolves.toMatchObject({
      clockHealth: 'clock-blocked',
      lastPlausibleWallTimeMs: 1_000_000,
      observedRollbackMs: 500_000,
    });
  });

  it('clears the block only after wall time is plausible again', async () => {
    const { repository, service } = await setup({
      lastPlausibleWallTimeMs: 1_000_000,
      clockHealth: 'clock-blocked',
      observedRollbackMs: 400_000,
    });

    await expect(service.check(699_999)).resolves.toBe('clock-blocked');
    await expect(service.check(700_000)).resolves.toBe('healthy');
    await expect(repository.readSchedulerState()).resolves.toMatchObject({
      clockHealth: 'healthy',
      lastPlausibleWallTimeMs: 1_000_000,
      observedRollbackMs: null,
    });
  });

  it('retries a lost scheduler CAS without overwriting an unrelated concurrent update', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const compareAndSet = repository.compareAndSetSchedulerState.bind(repository);
    const compareSpy = vi.spyOn(repository, 'compareAndSetSchedulerState');
    compareSpy.mockImplementationOnce(async (expectedRevision) => {
      expect(await compareAndSet(expectedRevision, { lastCleanupSuccessMs: 123 })).toBe(true);
      return false;
    });
    compareSpy.mockImplementation(compareAndSet);
    const service = new ArchiveClockHealthService(repository, new ArchiveWakeService());

    await expect(service.check(9_000_000)).resolves.toBe('healthy');

    expect(compareSpy.mock.calls.map(([revision]) => revision)).toEqual([0, 1]);
    await expect(repository.readSchedulerState()).resolves.toMatchObject({
      lastCleanupSuccessMs: 123,
      lastPlausibleWallTimeMs: 9_000_000,
      clockHealth: 'healthy',
    });
  });

  it('wakes only when the durable health state transitions', async () => {
    const wake = new ArchiveWakeService();
    const wakeSpy = vi.spyOn(wake, 'wake');
    const { service } = await setup({ lastPlausibleWallTimeMs: 1_000_000 }, wake);

    await service.check(699_999);
    await service.check(600_000);
    await service.check(700_000);

    expect(wakeSpy).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid wall-clock epoch: %s',
    async (nowMs) => {
      const { service } = await setup();

      await expect(service.check(nowMs)).rejects.toThrow('Archive wall-clock epoch is invalid');
    },
  );
});

async function setup(
  update: ArchiveSchedulerUpdate = {},
  wake = new ArchiveWakeService(),
) {
  const repository = new InMemoryArchiveArtifactRepository();
  if (Object.keys(update).length > 0) {
    const initial = await repository.readSchedulerState();
    expect(await repository.compareAndSetSchedulerState(initial.revision, update)).toBe(true);
  }
  return {
    repository,
    service: new ArchiveClockHealthService(repository, wake),
  };
}
