import { describe, expect, it, vi } from 'vitest';
import { FeatureInstallOutcomeRegistryService } from '../../../src/features/application/feature-install-outcome-registry.service';
import type { FeatureInstallJob } from '../../../src/features/domain/manageable-feature';

const job = (id: string): FeatureInstallJob => ({
  id,
  feature: 'digital',
  status: 'succeeded',
  requestedByUserId: 1,
  requestedInChatId: 2,
  workflowReceiptId: `receipt-${id}`,
  previousInstalled: false,
  previousEnabled: false,
  restartScope: 'worker',
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

    registry.register({ notify });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls.map(([delivered]) => (delivered as FeatureInstallJob).id))
      .toEqual(['first', 'second']);
  });

  it('keeps terminal persistence independent when a listener rejects', async () => {
    const registry = new FeatureInstallOutcomeRegistryService();
    registry.register({ notify: vi.fn().mockRejectedValue(new Error('telegram offline')) });

    await expect(registry.notify(job('retryable'))).resolves.toBeUndefined();
  });
});
