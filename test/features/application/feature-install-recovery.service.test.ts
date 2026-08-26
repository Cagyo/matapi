import { describe, expect, it, vi } from 'vitest';
import { FeatureInstallRecoveryService } from '../../../src/features/application/feature-install-recovery.service';
import type { FeatureInstallJob } from '../../../src/features/domain/manageable-feature';
import type { ReconcileFeatureInstallUseCase } from '../../../src/features/application/reconcile-feature-install.use-case';

const id = 'abcdefghijklmnop';
const base = new Date('2030-01-01T00:00:00.000Z');

function job(overrides: Partial<FeatureInstallJob> = {}): FeatureInstallJob {
  return {
    id, feature: 'digital', status: 'queued', activeSlot: 1, operation: 'install',
    requestedByUserId: 1, requestedInChatId: 2, workflowReceiptId: 'ponmlkjihgfedcba',
    previousInstalled: false, previousEnabled: false, restartScope: null,
    restartDispatchIdentity: null, failureCode: null,
    createdAt: base, updatedAt: base, ...overrides,
  };
}

function create(active: FeatureInstallJob, state: unknown) {
  let current = active;
  let time = base.getTime();
  const jobs = {
    findActive: vi.fn(async () => current),
    listRecentTerminal: vi.fn(async () => []),
    markRunning: vi.fn(async () => { current = { ...current, status: 'running' }; return current; }),
    terminalizeFailure: vi.fn(async () => { current = { ...current, status: 'failed', activeSlot: null, failureCode: 'interrupted' }; return current; }),
  };
  const requests = { publish: vi.fn(async () => 'published' as const), cancelUnclaimed: vi.fn(async () => false) };
  const results = { readState: vi.fn(async () => state), removeTerminal: vi.fn(async () => undefined) };
  const controller = { start: vi.fn(async () => undefined) };
  const reconcile = { execute: vi.fn(async () => current) } as unknown as ReconcileFeatureInstallUseCase;
  const outcomes = { register: vi.fn(), notify: vi.fn(async () => undefined) };
  const service = new FeatureInstallRecoveryService(jobs as never, requests, results, controller, reconcile, outcomes, { now: () => new Date(time) });
  return { service, jobs, requests, results, controller, reconcile, outcomes, advance: (ms: number) => { time += ms; } };
}

describe('FeatureInstallRecoveryService', () => {
  it('never timeouts a root-marked running job', async () => {
    const test = create(job({ updatedAt: new Date(base.getTime() - 36 * 60_000) }), { kind: 'running' });

    await test.service.runPass();
    await test.service.onModuleDestroy();

    expect(test.jobs.terminalizeFailure).not.toHaveBeenCalled();
    expect(test.requests.cancelUnclaimed).not.toHaveBeenCalled();
  });

  it('only terminalizes a stale absent job after exact unclaimed cancellation', async () => {
    const test = create(job({ updatedAt: new Date(base.getTime() - 36 * 60_000) }), { kind: 'absent' });
    test.requests.cancelUnclaimed.mockResolvedValue(true);

    await test.service.runPass();
    await test.service.onModuleDestroy();

    expect(test.requests.cancelUnclaimed).toHaveBeenCalledWith({ version: 1, jobId: id, feature: 'digital' });
    expect(test.jobs.terminalizeFailure).toHaveBeenCalledWith(expect.objectContaining({ failureCode: 'interrupted', attentionReason: 'partial-state-uncertain' }));
  });

  it('waits through the marker window before republishing a queued absent request', async () => {
    const test = create(job(), { kind: 'absent' });

    await test.service.runPass();
    expect(test.requests.publish).not.toHaveBeenCalled();
    test.advance(2_000);
    await test.service.runPass();
    await test.service.onModuleDestroy();

    expect(test.controller.start).toHaveBeenCalledTimes(2);
    expect(test.requests.publish).toHaveBeenCalledWith({ version: 1, jobId: id, feature: 'digital' });
  });
});
