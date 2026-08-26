import type { ManageableFeatureName } from '../../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import { Logger } from '@nestjs/common';
import { defaultExecFile, READINESS_COMMAND_OPTIONS, type FixedExecFile } from './readiness-seams';

export interface ZigbeeReadinessDependencies { execFile?: FixedExecFile; }

export class ZigbeeReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(ZigbeeReadinessAdapter.name);
  private readonly execFile: FixedExecFile;
  constructor(dependencies: ZigbeeReadinessDependencies = {}) { this.execFile = dependencies.execFile ?? defaultExecFile(); }

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    let check = 'mosquitto executable';
    try {
      await this.execFile('/usr/bin/which', ['mosquitto'], READINESS_COMMAND_OPTIONS);
      check = 'mosquitto_sub executable';
      await this.execFile('/usr/bin/which', ['mosquitto_sub'], READINESS_COMMAND_OPTIONS);
      check = 'mosquitto service';
      await this.execFile('/bin/systemctl', ['is-active', 'mosquitto.service'], READINESS_COMMAND_OPTIONS);
      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: zigbee ${check}`);
      return { ready: false, failureCode: 'application-verification-failed', reason: 'runtime-invalid' };
    }
  }
}
