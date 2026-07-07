import { describe, expect, it, vi } from 'vitest';
import { CleanupCoordinatorService } from '../../../src/camera/application/cleanup-coordinator.service';
import { TriggerCleanUseCase } from '../../../src/camera/application/trigger-clean.use-case';

describe('TriggerCleanUseCase', () => {
  it('delegates to coordinator runCleanup with both target', async () => {
    const coordinator = {
      runCleanup: vi.fn(async (_target, thresh) => ({ executed: true, thresholdUsed: thresh ?? 80 })),
    } as unknown as CleanupCoordinatorService;

    const useCase = new TriggerCleanUseCase(coordinator);
    const res = await useCase.execute(75);

    expect(res).toEqual({ executed: true, thresholdUsed: 75 });
    expect(coordinator.runCleanup).toHaveBeenCalledWith('both', 75);
  });

  it('handles execution without custom threshold', async () => {
    const coordinator = {
      runCleanup: vi.fn(async () => ({ executed: true, thresholdUsed: 80 })),
    } as unknown as CleanupCoordinatorService;

    const useCase = new TriggerCleanUseCase(coordinator);
    const res = await useCase.execute();

    expect(res).toEqual({ executed: true, thresholdUsed: 80 });
    expect(coordinator.runCleanup).toHaveBeenCalledWith('both', undefined);
  });
});
