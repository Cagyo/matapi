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

  it('delegates a registered transition wrapper and passes through every other feature', async () => {
    const registry = new FeatureDisableLifecycleRegistry();
    const trace: string[] = [];
    registry.register('rtsp', {
      beforeDisable: vi.fn(),
      afterEnable: vi.fn(),
      runTransition: async (operation) => {
        trace.push('wrapper:enter');
        try {
          return await operation();
        } finally {
          trace.push('wrapper:leave');
        }
      },
    });
    registry.register('digital', { beforeDisable: vi.fn(), afterEnable: vi.fn() });

    await expect(registry.runTransition('rtsp', async () => {
      trace.push('rtsp:operation');
      return 'rtsp-result';
    })).resolves.toBe('rtsp-result');
    await expect(registry.runTransition('digital', async () => {
      trace.push('digital:operation');
      return 'digital-result';
    })).resolves.toBe('digital-result');
    await registry.runTransition('motion', async () => {
      trace.push('missing:operation');
    });

    expect(trace).toEqual([
      'wrapper:enter',
      'rtsp:operation',
      'wrapper:leave',
      'digital:operation',
      'missing:operation',
    ]);
  });
});
