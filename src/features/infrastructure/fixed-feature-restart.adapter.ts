import { Injectable } from '@nestjs/common';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RestartScope } from '../domain/manageable-feature';
import type { FeatureRestartPort } from '../domain/ports/feature-restart.port';
import type { ProcessRestarterPort } from '../../system/domain/ports/process-restarter.port';

type ExecFile = (file: string, args: readonly string[]) => Promise<unknown>;

const execFile: ExecFile = async (file, args) => promisify(nodeExecFile)(file, [...args]);

@Injectable()
export class FixedFeatureRestartAdapter implements FeatureRestartPort {
  constructor(
    private readonly restarter: ProcessRestarterPort,
    private readonly run: ExecFile = execFile,
  ) {}

  async dispatch(scope: RestartScope): Promise<void> {
    if (scope === 'worker') return this.restarter.restart();
    const unit = scope === 'supervisor'
      ? 'homeworker-feature-supervisor-restart.service'
      : scope === 'host'
        ? 'homeworker-feature-host-reboot.service'
        : null;
    if (!unit) throw new RangeError('Unsupported feature restart scope');
    await this.run('/usr/bin/sudo', ['/bin/systemctl', 'start', '--no-block', unit]);
  }
}
