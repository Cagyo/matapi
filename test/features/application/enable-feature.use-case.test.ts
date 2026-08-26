import { describe, expect, it, vi } from 'vitest';
import { EnableFeatureUseCase } from '../../../src/features/application/enable-feature.use-case';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';
import { FeatureInstallBusyError } from '../../../src/features/domain/errors/feature-install-busy.error';
import { FeatureInconsistentError } from '../../../src/features/domain/errors/feature-inconsistent.error';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../../../src/features/domain/errors/feature-state-changed.error';
import { FeatureVerificationError } from '../../../src/features/domain/errors/feature-verification.error';
import type { FeatureInstallJobRepositoryPort } from '../../../src/features/domain/ports/feature-install-job.repository.port';
import type { FeatureRestartPort } from '../../../src/features/domain/ports/feature-restart.port';
import type { FeatureRuntimeLifecycleRegistryPort } from '../../../src/features/domain/ports/feature-runtime-lifecycle.port';
import { InMemoryFeatureReadinessAdapter } from '../../../src/features/infrastructure/in-memory-feature-readiness.adapter';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

const expected = { installed: true, enabled: false, attentionReason: null } as const;

function setup() {
  const features = new InMemoryFeatureRepository([
    { name: 'digital', installed: true, enabled: false, config: null, attentionReason: null },
  ]);
  const jobs: Pick<FeatureInstallJobRepositoryPort, 'findActive'> = {
    findActive: vi.fn().mockResolvedValue(null),
  };
  const readiness = new InMemoryFeatureReadinessAdapter();
  const verify = new VerifyFeatureReadinessUseCase(features, readiness);
  const lifecycle: Pick<FeatureRuntimeLifecycleRegistryPort, 'beforeDisable' | 'afterEnable'> = {
    beforeDisable: vi.fn().mockResolvedValue(undefined),
    afterEnable: vi.fn().mockResolvedValue(undefined),
  };
  const restart: FeatureRestartPort = { dispatch: vi.fn().mockResolvedValue(undefined) };
  return {
    features,
    jobs,
    readiness,
    verify,
    lifecycle,
    restart,
    useCase: new EnableFeatureUseCase(features, jobs, verify, lifecycle, restart),
  };
}

describe('EnableFeatureUseCase', () => {
  it('enables only after readiness and then reloads runtime before worker restart', async () => {
    const { useCase, verify, lifecycle, restart } = setup();
    const order: string[] = [];
    vi.spyOn(verify, 'execute').mockImplementation(async () => {
      order.push('verify');
      return { ready: true, restartScope: 'worker' };
    });
    vi.mocked(lifecycle.afterEnable).mockImplementation(async () => { order.push('reload'); });
    vi.mocked(restart.dispatch).mockImplementation(async () => { order.push('restart'); });

    const result = await useCase.execute({ name: 'digital', expected });

    expect(result).toMatchObject({ feature: { enabled: true }, restartScope: 'worker' });
    expect(order).toEqual(['verify', 'reload', 'restart']);
    expect(verify.execute).toHaveBeenCalledWith({ name: 'digital', source: 'mutation' });
  });

  it('blocks only an active install of the same feature', async () => {
    const same = setup();
    vi.mocked(same.jobs.findActive).mockResolvedValue({ feature: 'digital' } as never);
    await expect(same.useCase.execute({ name: 'digital', expected })).rejects.toBeInstanceOf(FeatureInstallBusyError);

    const different = setup();
    vi.mocked(different.jobs.findActive).mockResolvedValue({ feature: 'motion' } as never);
    await expect(different.useCase.execute({ name: 'digital', expected })).resolves.toMatchObject({
      feature: { enabled: true },
    });
  });

  it('writes readiness attention and makes no other change when verification fails', async () => {
    const { useCase, features, readiness, lifecycle, restart } = setup();
    readiness.set('digital', { ready: false, failureCode: 'application-verification-failed', reason: 'runtime-invalid' });

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toBeInstanceOf(FeatureVerificationError);
    expect(await features.findByName('digital')).toMatchObject({ enabled: false, attentionReason: 'readiness-failed' });
    expect(lifecycle.afterEnable).not.toHaveBeenCalled();
    expect(restart.dispatch).not.toHaveBeenCalled();
  });

  it('rejects attention state before changing state', async () => {
    const { useCase, features } = setup();
    await features.setAttention('digital', 'readiness-failed');

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toBeInstanceOf(FeatureInconsistentError);
  });

  it('rejects a CAS race as stale', async () => {
    const { useCase, features } = setup();
    features.compareAndSetEnabled = vi.fn().mockResolvedValue(null);

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toBeInstanceOf(FeatureStateChangedError);
  });

  it('preserves concurrent attention written during mutation readiness and skips effects', async () => {
    const { useCase, features, readiness, lifecycle, restart } = setup();
    readiness.verify = async () => {
      await features.setAttention('digital', 'partial-state-uncertain');
      return { ready: true, restartScope: 'worker' };
    };

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toBeInstanceOf(FeatureStateChangedError);
    expect(await features.findByName('digital')).toMatchObject({
      enabled: false,
      attentionReason: 'partial-state-uncertain',
    });
    expect(lifecycle.afterEnable).not.toHaveBeenCalled();
    expect(restart.dispatch).not.toHaveBeenCalled();
  });

  it('compensates a failed reload by tearing down and returning to disabled', async () => {
    const { useCase, features, lifecycle, restart } = setup();
    const failure = new Error('reload failed');
    vi.mocked(lifecycle.afterEnable).mockRejectedValue(failure);

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toBe(failure);
    expect(lifecycle.beforeDisable).toHaveBeenCalledWith('digital');
    expect(await features.findByName('digital')).toMatchObject({ enabled: false, attentionReason: null });
    expect(restart.dispatch).not.toHaveBeenCalled();
  });

  it('keeps enabled and marks partial uncertainty when failed reload cannot be torn down', async () => {
    const { useCase, features, lifecycle } = setup();
    const failure = new Error('reload failed');
    vi.mocked(lifecycle.afterEnable).mockRejectedValue(failure);
    vi.mocked(lifecycle.beforeDisable).mockRejectedValue(new Error('teardown failed'));

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toBe(failure);
    expect(await features.findByName('digital')).toMatchObject({ enabled: true, attentionReason: 'partial-state-uncertain' });
  });

  it('marks restart required without rolling state back when restart dispatch fails', async () => {
    const { useCase, features, restart } = setup();
    vi.mocked(restart.dispatch).mockRejectedValue(new Error('restart failed'));

    await expect(useCase.execute({ name: 'digital', expected })).rejects.toEqual(
      new FeatureRestartDispatchError('digital', 'worker'),
    );
    expect(await features.findByName('digital')).toMatchObject({ enabled: true, attentionReason: 'restart-required' });
  });
});
