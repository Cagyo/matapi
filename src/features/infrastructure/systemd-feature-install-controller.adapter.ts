import { execFile as childExecFile } from 'node:child_process';
import type { FeatureInstallControllerPort } from '../domain/ports/feature-install-controller.port';

const UNIT = 'homeworker-feature-install.service';
type ExecFile = (
  file: string,
  args: readonly string[],
  options: { shell: false; cwd: '/'; timeout: number; env: Record<string, string> },
  callback: (error: Error | null) => void,
) => unknown;

export class SystemdFeatureInstallControllerAdapter implements FeatureInstallControllerPort {
  constructor(private readonly execFile: ExecFile = childExecFile as unknown as ExecFile) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.execFile('/usr/bin/sudo', ['-n', '/bin/systemctl', 'start', '--no-block', UNIT], {
      shell: false, cwd: '/', timeout: 15_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
    }, (error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
}
