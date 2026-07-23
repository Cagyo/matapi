import { describe, expect, it, vi } from 'vitest';
import { FixedFeatureRestartAdapter } from '../../../src/features/infrastructure/fixed-feature-restart.adapter';

describe('FixedFeatureRestartAdapter', () => {
  it('delegates worker restart to the process restarter', async () => {
    const restarter = { restart: vi.fn().mockResolvedValue(undefined) };
    const execFile = vi.fn().mockResolvedValue(undefined);
    const adapter = new FixedFeatureRestartAdapter(restarter, execFile);

    await adapter.dispatch('worker');

    expect(restarter.restart).toHaveBeenCalledOnce();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    ['supervisor', 'homeworker-feature-supervisor-restart.service'],
    ['host', 'homeworker-feature-host-reboot.service'],
  ] as const)('uses the fixed systemd unit for %s', async (scope, unit) => {
    const execFile = vi.fn().mockResolvedValue(undefined);
    const adapter = new FixedFeatureRestartAdapter({ restart: vi.fn() }, execFile);

    await adapter.dispatch(scope);

    expect(execFile).toHaveBeenCalledWith('/usr/bin/sudo', [
      '/bin/systemctl', 'start', '--no-block', unit,
    ]);
  });

  it('rejects unsupported scopes before spawning', async () => {
    const execFile = vi.fn();
    const adapter = new FixedFeatureRestartAdapter({ restart: vi.fn() }, execFile);

    await expect(adapter.dispatch('package' as never)).rejects.toThrow(RangeError);
    expect(execFile).not.toHaveBeenCalled();
  });
});
