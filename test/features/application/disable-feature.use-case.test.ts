import { describe, expect, it, vi } from 'vitest';
import { DisableFeatureUseCase } from '../../../src/features/application/disable-feature.use-case';
import { FeatureInstallBusyError } from '../../../src/features/domain/errors/feature-install-busy.error';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../../../src/features/domain/errors/feature-state-changed.error';
import type { FeatureInstallJobRepositoryPort } from '../../../src/features/domain/ports/feature-install-job.repository.port';
import type { FeatureRestartPort } from '../../../src/features/domain/ports/feature-restart.port';
import type { FeatureRuntimeLifecycleRegistryPort } from '../../../src/features/domain/ports/feature-runtime-lifecycle.port';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

const expected = { installed: true, enabled: true, attentionReason: null } as const;

function setup() {
  const features = new InMemoryFeatureRepository([
    { name: 'uart', installed: true, enabled: true, config: null, attentionReason: null },
  ]);
  const jobs: Pick<FeatureInstallJobRepositoryPort, 'findActive'> = {
    findActive: vi.fn().mockResolvedValue(null),
  };
  const lifecycle: Pick<FeatureRuntimeLifecycleRegistryPort, 'beforeDisable' | 'afterEnable'> = {
    beforeDisable: vi.fn().mockResolvedValue(undefined),
    afterEnable: vi.fn().mockResolvedValue(undefined),
  };
  const restart: FeatureRestartPort = { dispatch: vi.fn().mockResolvedValue(undefined) };
  return {
    features,
    jobs,
    lifecycle,
    restart,
    useCase: new DisableFeatureUseCase(features, jobs, lifecycle, restart),
  };
}

describe('DisableFeatureUseCase', () => {
  it('tears down before CAS, retains installed, and then restarts the worker', async () => {
    const { useCase, features, lifecycle, restart } = setup();
    const order: string[] = [];
    vi.mocked(lifecycle.beforeDisable).mockImplementation(async () => { order.push('teardown'); });
    const compare = features.compareAndSetEnabled.bind(features);
    features.compareAndSetEnabled = async (input) => {
      order.push('persist');
      return compare(input);
    };
    vi.mocked(restart.dispatch).mockImplementation(async () => { order.push('restart'); });

    const result = await useCase.execute({ name: 'uart', expected });

    expect(result).toMatchObject({ feature: { installed: true, enabled: false }, restartScope: 'worker' });
    expect(order).toEqual(['teardown', 'persist', 'restart']);
  });

  it('blocks only an active install of the same feature', async () => {
    const same = setup();
    vi.mocked(same.jobs.findActive).mockResolvedValue({ feature: 'uart' } as never);
    await expect(same.useCase.execute({ name: 'uart', expected })).rejects.toBeInstanceOf(FeatureInstallBusyError);

    const different = setup();
    vi.mocked(different.jobs.findActive).mockResolvedValue({ feature: 'motion' } as never);
    await expect(different.useCase.execute({ name: 'uart', expected })).resolves.toMatchObject({
      feature: { enabled: false },
    });
  });

  it('leaves the flag unchanged when teardown fails and attempts recovery', async () => {
    const { useCase, features, lifecycle } = setup();
    vi.mocked(lifecycle.beforeDisable).mockRejectedValue(new Error('bounded teardown failed'));

    await expect(useCase.execute({ name: 'uart', expected })).rejects.toThrow('bounded teardown failed');
    expect(lifecycle.afterEnable).toHaveBeenCalledWith('uart');
    expect(await features.findByName('uart')).toMatchObject({ enabled: true });
  });

  it('restores runtime when CAS loses a race after teardown', async () => {
    const { useCase, features, lifecycle } = setup();
    features.compareAndSetEnabled = vi.fn().mockResolvedValue(null);

    await expect(useCase.execute({ name: 'uart', expected })).rejects.toBeInstanceOf(FeatureStateChangedError);
    expect(lifecycle.afterEnable).toHaveBeenCalledWith('uart');
    expect(await features.findByName('uart')).toMatchObject({ enabled: true });
  });

  it('marks partial uncertainty when runtime restoration fails after a CAS race', async () => {
    const { useCase, features, lifecycle } = setup();
    features.compareAndSetEnabled = vi.fn().mockResolvedValue(null);
    vi.mocked(lifecycle.afterEnable).mockRejectedValue(new Error('restore failed'));

    await expect(useCase.execute({ name: 'uart', expected })).rejects.toBeInstanceOf(FeatureStateChangedError);
    expect(await features.findByName('uart')).toMatchObject({ enabled: true, attentionReason: 'partial-state-uncertain' });
  });

  it('marks restart required without rolling state back when restart dispatch fails', async () => {
    const { useCase, features, restart } = setup();
    vi.mocked(restart.dispatch).mockRejectedValue(new Error('restart failed'));

    await expect(useCase.execute({ name: 'uart', expected })).rejects.toEqual(
      new FeatureRestartDispatchError('uart', 'worker'),
    );
    expect(await features.findByName('uart')).toMatchObject({ enabled: false, attentionReason: 'restart-required' });
  });
});
