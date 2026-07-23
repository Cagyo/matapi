import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import type { ManageableFeatureName } from '../../domain/manageable-feature';
import { Logger } from '@nestjs/common';
import { defaultExecFile, openTcp, READINESS_COMMAND_OPTIONS, type FixedExecFile } from './readiness-seams';

export interface DigitalReadinessDependencies {
  execFile?: FixedExecFile;
  connect?: (host: string, port: number) => Promise<void>;
  host?: string;
  port?: number;
}

export class DigitalReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(DigitalReadinessAdapter.name);
  private readonly execFile: FixedExecFile;
  private readonly connect: (host: string, port: number) => Promise<void>;
  private readonly host: string;
  private readonly port: number;

  constructor(dependencies: DigitalReadinessDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
    this.connect = dependencies.connect ?? openTcp;
    this.host = dependencies.host ?? process.env.PIGPIOD_HOST ?? 'localhost';
    this.port = dependencies.port ?? parsePort(process.env.PIGPIOD_PORT);
  }

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    let check = 'pigpiod executable';
    try {
      await this.execFile('/usr/bin/which', ['pigpiod'], READINESS_COMMAND_OPTIONS);
      check = 'pigpiod service';
      await this.execFile('/bin/systemctl', ['is-active', 'pigpiod.service'], READINESS_COMMAND_OPTIONS);
      check = 'pigpiod TCP connection';
      await this.connect(this.host, this.port);
      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: digital ${check}`);
      return { ready: false, failureCode: 'application-verification-failed' };
    }
  }
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? '8888', 10);
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 ? port : 8888;
}
