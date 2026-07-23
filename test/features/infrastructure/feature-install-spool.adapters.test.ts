import { describe, expect, it, vi } from 'vitest';
import { SystemdFeatureInstallControllerAdapter } from '../../../src/features/infrastructure/systemd-feature-install-controller.adapter';

describe('feature install spool adapters', () => {
  it('can start only the fixed installer unit without a shell', async () => {
    const execFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      done: (error: Error | null) => void,
    ) => done(null));
    await new SystemdFeatureInstallControllerAdapter(execFile).start();
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/bin/systemctl', 'start', '--no-block', 'homeworker-feature-install.service'],
      expect.objectContaining({ shell: false, timeout: 15_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } }),
      expect.any(Function),
    );
  });
});
