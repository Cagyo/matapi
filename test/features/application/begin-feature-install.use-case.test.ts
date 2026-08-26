import { describe, expect, it, vi } from 'vitest';
import { BeginFeatureInstallUseCase } from '../../../src/features/application/begin-feature-install.use-case';
import { FeatureInstallStartError } from '../../../src/features/domain/errors/feature-install-start.error';
import { FeatureStateChangedError } from '../../../src/features/domain/errors/feature-state-changed.error';
import type { Feature } from '../../../src/features/domain/feature.entity';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';
import type { FeatureInstallRecoveryService } from '../../../src/features/application/feature-install-recovery.service';

const now = new Date('2030-01-01T00:00:00.000Z');
const input = {
  id: 'abcdefghijklmnop',
  feature: 'digital' as const,
  operation: 'install' as const,
  requestedByUserId: 1,
  requestedInChatId: 2,
  workflowReceiptId: 'ponmlkjihgfedcba',
  expected: { installed: false, enabled: false },
};

const reinstall = {
  ...input,
  feature: 'rtsp' as const,
  operation: 'reinstall' as const,
  expected: { installed: true, enabled: true },
};

const INSTALLED_RTSP: Feature = {
  name: 'rtsp', installed: true, enabled: true, config: null, attentionReason: null,
};

function create(seed: readonly Feature[] = []) {
  const features = new InMemoryFeatureRepository([
    { name: 'digital', installed: false, enabled: false, config: null, attentionReason: null },
    ...seed,
  ]);
  const jobs = new InMemoryFeatureInstallJobRepository(features);
  const trace: string[] = [];
  const request = {
    publish: vi.fn(async () => { trace.push('publish'); return 'published' as const; }),
    cancelUnclaimed: vi.fn(async () => { trace.push('cancel'); return true; }),
  };
  const controller = { start: vi.fn(async () => undefined) };
  const lifecycle = {
    beforeDisable: vi.fn(async () => { trace.push('before-disable'); }),
    afterEnable: vi.fn(async () => { trace.push('after-enable'); }),
  };
  const recovery = { wake: vi.fn() } as unknown as FeatureInstallRecoveryService;
  return {
    features, jobs, request, controller, lifecycle, recovery, trace,
    useCase: new BeginFeatureInstallUseCase(
      jobs, request, controller, lifecycle, { now: () => now }, recovery,
    ),
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

  it('leaves a first install runtime untouched', async () => {
    const test = create();

    await test.useCase.execute(input);

    expect(test.lifecycle.beforeDisable).not.toHaveBeenCalled();
    expect(test.lifecycle.afterEnable).not.toHaveBeenCalled();
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

  describe('reinstall on the current network', () => {
    it('records the requested operation and the exact prior state', async () => {
      const test = create([INSTALLED_RTSP]);

      await test.useCase.execute(reinstall);

      expect(await test.jobs.findById(reinstall.id)).toMatchObject({
        feature: 'rtsp', operation: 'reinstall', status: 'running',
        previousInstalled: true, previousEnabled: true,
      });
    });

    it('stands the runtime down before the helper can see the request', async () => {
      const test = create([INSTALLED_RTSP]);

      await test.useCase.execute(reinstall);

      expect(test.lifecycle.beforeDisable).toHaveBeenCalledOnce();
      expect(test.lifecycle.beforeDisable).toHaveBeenCalledWith('rtsp');
      expect(test.trace).toEqual(['before-disable', 'publish']);
    });

    it('refuses a confirmation whose captured state no longer matches', async () => {
      const test = create([{ ...INSTALLED_RTSP, enabled: false }]);

      await expect(test.useCase.execute(reinstall)).rejects.toBeInstanceOf(FeatureStateChangedError);

      expect(await test.jobs.findActive()).toBeNull();
      expect(test.lifecycle.beforeDisable).not.toHaveBeenCalled();
      expect(test.request.publish).not.toHaveBeenCalled();
    });

    it('preserves the feature and reopens the runtime when the request is provably unpublished', async () => {
      const test = create([INSTALLED_RTSP]);
      test.request.publish.mockRejectedValue(new Error('spool unavailable'));

      await expect(test.useCase.execute(reinstall)).rejects.toBeInstanceOf(FeatureInstallStartError);

      expect(await test.jobs.findById(reinstall.id)).toMatchObject({
        status: 'failed', activeSlot: null, failureCode: 'request-publish-failed',
      });
      expect(await test.features.findByName('rtsp')).toMatchObject({
        installed: true, enabled: true, attentionReason: null,
      });
      expect(test.trace).toEqual(['before-disable', 'cancel', 'after-enable']);
    });

    it('keeps the runtime closed while an unclaimed request may still run', async () => {
      const test = create([INSTALLED_RTSP]);
      test.request.publish.mockRejectedValue(new Error('unknown publication state'));
      test.request.cancelUnclaimed.mockResolvedValue(false);

      await expect(test.useCase.execute(reinstall)).rejects.toBeInstanceOf(FeatureInstallStartError);

      expect(test.lifecycle.afterEnable).not.toHaveBeenCalled();
      expect(await test.jobs.findById(reinstall.id)).toMatchObject({ status: 'queued', activeSlot: 1 });
    });

    it('releases the slot and reopens the runtime when standing it down fails', async () => {
      const test = create([INSTALLED_RTSP]);
      test.lifecycle.beforeDisable.mockRejectedValue(new Error('sessions will not stop'));

      await expect(test.useCase.execute(reinstall)).rejects.toBeInstanceOf(FeatureInstallStartError);

      expect(test.request.publish).not.toHaveBeenCalled();
      expect(await test.jobs.findById(reinstall.id)).toMatchObject({
        status: 'failed', activeSlot: null, failureCode: 'request-publish-failed',
      });
      expect(await test.features.findByName('rtsp')).toMatchObject({ installed: true, enabled: true });
      expect(test.lifecycle.afterEnable).toHaveBeenCalledOnce();
      expect(test.lifecycle.afterEnable).toHaveBeenCalledWith('rtsp');
    });

    it('leaves a disabled feature closed instead of reopening it', async () => {
      const test = create([{ ...INSTALLED_RTSP, enabled: false }]);
      test.request.publish.mockRejectedValue(new Error('spool unavailable'));

      await expect(test.useCase.execute({
        ...reinstall, expected: { installed: true, enabled: false },
      })).rejects.toBeInstanceOf(FeatureInstallStartError);

      expect(test.lifecycle.afterEnable).not.toHaveBeenCalled();
    });
  });
});
