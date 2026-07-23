import { describe, expect, it, vi } from 'vitest';
import { FeatureDisableLifecycleRegistry } from '../../../src/features/application/feature-disable-lifecycle-registry.service';

describe('FeatureDisableLifecycleRegistry', () => {
  it('routes lifecycle calls by feature and treats missing lifecycles as no-ops', async () => {
    const registry = new FeatureDisableLifecycleRegistry();
    const lifecycle = { beforeDisable: vi.fn(), afterEnable: vi.fn() };
    registry.register('rtsp', lifecycle);

    await registry.beforeDisable('digital');
    await registry.afterEnable('digital');
    await registry.beforeDisable('rtsp');
    await registry.afterEnable('rtsp');

    expect(lifecycle.beforeDisable).toHaveBeenCalledOnce();
    expect(lifecycle.afterEnable).toHaveBeenCalledOnce();
  });

  it('rejects duplicate registration for the same feature', () => {
    const registry = new FeatureDisableLifecycleRegistry();
    registry.register('rtsp', { beforeDisable: vi.fn(), afterEnable: vi.fn() });

    expect(() => registry.register('rtsp', { beforeDisable: vi.fn(), afterEnable: vi.fn() })).toThrow(RangeError);
  });
});
