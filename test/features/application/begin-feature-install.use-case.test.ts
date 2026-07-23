import { describe, expect, it, vi } from 'vitest';
import { BeginFeatureInstallUseCase } from '../../../src/features/application/begin-feature-install.use-case';
import { FeatureInstallStartError } from '../../../src/features/domain/errors/feature-install-start.error';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';
import type { FeatureInstallRecoveryService } from '../../../src/features/application/feature-install-recovery.service';

const now = new Date('2030-01-01T00:00:00.000Z');
const input = {
  id: 'abcdefghijklmnop',
  feature: 'digital' as const,
  requestedByUserId: 1,
  requestedInChatId: 2,
  workflowReceiptId: 'ponmlkjihgfedcba',
  expected: { installed: false as const, enabled: false as const },
};

function create() {
  const features = new InMemoryFeatureRepository([
    { name: 'digital', installed: false, enabled: false, config: null, attentionReason: null },
  ]);
  const jobs = new InMemoryFeatureInstallJobRepository(features);
  const request = { publish: vi.fn(async () => 'published' as const), cancelUnclaimed: vi.fn(async () => true) };
  const controller = { start: vi.fn(async () => undefined) };
  const recovery = { wake: vi.fn() } as unknown as FeatureInstallRecoveryService;
  return {
    jobs, request, controller, recovery,
    useCase: new BeginFeatureInstallUseCase(jobs, request, controller, { now: () => now }, recovery),
  };
}

describe('BeginFeatureInstallUseCase', () => {
  it('persists the queued job before publishing, then starts and marks it running', async () => {
    const test = create();
    test.request.publish.mockImplementation(async () => {
      expect(await test.jobs.findById(input.id)).toMatchObject({ status: 'queued', activeSlot: 1 });
      return 'published';
    });

    await expect(test.useCase.execute(input)).resolves.toMatchObject({ stage: 'running', job: { status: 'running' } });

    expect(test.controller.start).toHaveBeenCalledOnce();
    expect(test.recovery.wake).toHaveBeenCalledOnce();
  });

  it('terminalizes a rejected start only after cancelling the exact unclaimed request', async () => {
    const test = create();
    test.controller.start.mockRejectedValue(new Error('unit rejected'));

    await expect(test.useCase.execute(input)).rejects.toBeInstanceOf(FeatureInstallStartError);

    expect(test.request.cancelUnclaimed).toHaveBeenCalledWith({ version: 1, jobId: input.id, feature: 'digital' });
    expect(await test.jobs.findById(input.id)).toMatchObject({ status: 'failed', activeSlot: null, failureCode: 'request-publish-failed' });
  });

  it('leaves an active job for recovery when cancellation cannot prove it is unclaimed', async () => {
    const test = create();
    test.request.publish.mockRejectedValue(new Error('unknown publication state'));
    test.request.cancelUnclaimed.mockResolvedValue(false);

    await expect(test.useCase.execute(input)).rejects.toBeInstanceOf(FeatureInstallStartError);

    expect(await test.jobs.findById(input.id)).toMatchObject({ status: 'queued', activeSlot: 1 });
    expect(test.recovery.wake).toHaveBeenCalledOnce();
  });
});
