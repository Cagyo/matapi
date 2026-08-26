import { describe, expect, it, vi } from 'vitest';
import { FeatureInstallOutcomeRegistryService } from '../../../src/features/application/feature-install-outcome-registry.service';
import type { FeatureInstallJob } from '../../../src/features/domain/manageable-feature';

const job = (id: string): FeatureInstallJob => ({
  id,
  feature: 'digital',
  status: 'succeeded',
  operation: 'install',
  requestedByUserId: 1,
  requestedInChatId: 2,
  workflowReceiptId: `receipt-${id}`,
  previousInstalled: false,
  previousEnabled: false,
  restartScope: 'worker',
  restartDispatchIdentity: null,
  failureCode: null,
  attentionReason: null,
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
});

describe('FeatureInstallOutcomeRegistryService', () => {
  it('replays terminal jobs to a listener registered after recovery in persisted order', async () => {
    const registry = new FeatureInstallOutcomeRegistryService();
    await registry.notify(job('first'));
    await registry.notify(job('second'));
    const notify = vi.fn().mockResolvedValue(undefined);

    registry.register({ notifyPreRestart: vi.fn(), notify });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls.map(([delivered]) => (delivered as FeatureInstallJob).id))
      .toEqual(['first', 'second']);
  });

  it('keeps a rejected listener retryable and delivers exactly once on the next recovery pass', async () => {
    const registry = new FeatureInstallOutcomeRegistryService();
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValueOnce(undefined);
    registry.register({ notifyPreRestart: vi.fn(), notify });

    await expect(registry.notify(job('retryable'))).resolves.toBeUndefined();
    await expect(registry.notify(job('retryable'))).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
