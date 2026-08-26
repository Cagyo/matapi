import { describe, expect, it, vi } from 'vitest';
import { ReconcileFeatureInstallUseCase } from '../../../src/features/application/reconcile-feature-install.use-case';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import type { FeatureInstallResultV1 } from '../../../src/features/domain/manageable-feature';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureReadinessAdapter } from '../../../src/features/infrastructure/in-memory-feature-readiness.adapter';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';

const now = new Date('2030-01-01T00:00:00.000Z');
const id = 'abcdefghijklmnop';
const request = { id, feature: 'digital' as const, operation: 'install' as const, requestedByUserId: 1, requestedInChatId: 2, workflowReceiptId: 'ponmlkjihgfedcba', expected: { installed: false, enabled: false }, now };
const success: FeatureInstallResultV1 = { version: 1, jobId: id, feature: 'digital', outcome: 'succeeded', failureCode: null, privilegedReady: true, restartScope: 'worker' };

function create(state: unknown = { kind: 'terminal', result: success }) {
  const features = new InMemoryFeatureRepository([{ name: 'digital', installed: false, enabled: false, config: null, attentionReason: null }]);
  const jobs = new InMemoryFeatureInstallJobRepository(features);
  const readiness = new InMemoryFeatureReadinessAdapter();
  const results = { readState: vi.fn(async () => state), removeTerminal: vi.fn(async () => undefined) };
  const lifecycle = { register: vi.fn(), beforeDisable: vi.fn(async () => undefined), afterEnable: vi.fn(async () => undefined) };
  const restart = { dispatch: vi.fn(async () => undefined) };
  const outcomes = { register: vi.fn(), notifyPreRestart: vi.fn(async () => undefined), notify: vi.fn(async () => undefined) };
  const useCase = new ReconcileFeatureInstallUseCase(
    jobs, results, new VerifyFeatureReadinessUseCase(features, readiness), lifecycle, restart, features, outcomes, { now: () => now },
  );
  return { features, jobs, readiness, results, lifecycle, restart, outcomes, useCase };
}

async function running(test: ReturnType<typeof create>) {
  await test.jobs.createQueued(request);
  await test.jobs.markRunning(id, now);
}

describe('ReconcileFeatureInstallUseCase', () => {
  it('sends a best-effort pre-restart copy before dispatch and defers exact outcome delivery', async () => {
    const test = create();
    await running(test);
    const order: string[] = [];
    test.results.removeTerminal.mockImplementation(async () => {
      expect(await test.jobs.findById(id)).toMatchObject({ status: 'succeeded', activeSlot: null });
      order.push('remove');
    });
    test.lifecycle.afterEnable.mockImplementation(async () => { order.push('lifecycle'); });
    test.outcomes.notifyPreRestart.mockImplementation(async () => { order.push('pre-restart'); });
    test.restart.dispatch.mockImplementation(async () => { order.push('restart'); });

    await test.useCase.execute(id);

    expect(order).toEqual(['remove', 'lifecycle', 'pre-restart', 'restart']);
    expect(test.outcomes.notify).not.toHaveBeenCalled();
    expect(await test.features.findByName('digital')).toMatchObject({ installed: true, enabled: true, attentionReason: null });
  });

  it('treats a result marker as progress and does not terminalize it', async () => {
    const test = create({ kind: 'running' });
    await test.jobs.createQueued(request);

    await test.useCase.execute(id);

    expect(await test.jobs.findById(id)).toMatchObject({ status: 'running', activeSlot: 1 });
    expect(test.results.removeTerminal).not.toHaveBeenCalled();
  });

  it('probes non-safe helper failures and records uncertainty when readiness is not proven', async () => {
    const failed: FeatureInstallResultV1 = { version: 1, jobId: id, feature: 'digital', outcome: 'failed', failureCode: 'dependency-install-failed', privilegedReady: false, restartScope: null };
    const test = create({ kind: 'terminal', result: failed });
    test.readiness.set('digital', { ready: false, failureCode: 'application-verification-failed' });
    await running(test);

    await test.useCase.execute(id);

    expect(await test.jobs.findById(id)).toMatchObject({ status: 'failed', failureCode: 'partial-state-uncertain', activeSlot: null });
    expect(await test.features.findByName('digital')).toMatchObject({ attentionReason: 'partial-state-uncertain' });
  });

  it('does not retry a restart after terminal success', async () => {
    const test = create();
    test.restart.dispatch.mockRejectedValue(new Error('PM2 unavailable'));
    await running(test);

    await expect(test.useCase.execute(id)).rejects.toBeInstanceOf(FeatureRestartDispatchError);
    await expect(test.useCase.execute(id)).resolves.toMatchObject({ status: 'succeeded' });

    expect(test.restart.dispatch).toHaveBeenCalledTimes(1);
    expect(await test.features.findByName('digital')).toMatchObject({ attentionReason: 'restart-required' });
    expect(test.outcomes.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
  });
});
