import type { ManageableFeatureName } from '../../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import { Logger } from '@nestjs/common';
import { defaultExecFile, nodeReadinessFiles, READINESS_COMMAND_OPTIONS, type FixedExecFile } from './readiness-seams';

interface UartFiles {
  readFile(path: string): Promise<string>;
  openReadWrite(path: string): Promise<void>;
}

export interface UartReadinessDependencies {
  execFile?: FixedExecFile;
  files?: UartFiles;
  serialDevice?: string;
}

export class UartReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(UartReadinessAdapter.name);
  private readonly execFile: FixedExecFile;
  private readonly files: UartFiles;
  private readonly serialDevice: string;

  constructor(dependencies: UartReadinessDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
    this.files = dependencies.files ?? nodeReadinessFiles;
    this.serialDevice = dependencies.serialDevice ?? process.env.UART_DEVICE ?? '/dev/serial0';
  }

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    let check = 'boot configuration';
    try {
      const config = await this.readBootConfig();
      if (!/^\s*enable_uart\s*=\s*1\s*$/mu.test(config)) throw new Error('UART disabled');
      check = 'serial console';
      await this.assertConsoleDisabled();
      check = 'serial device access';
      await this.files.openReadWrite(this.serialDevice);
      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: uart ${check}`);
      return { ready: false, failureCode: 'application-verification-failed' };
    }
  }

  private async readBootConfig(): Promise<string> {
    try {
      return await this.files.readFile('/boot/firmware/config.txt');
    } catch {
      return this.files.readFile('/boot/config.txt');
    }
  }

  private async assertConsoleDisabled(): Promise<void> {
    try {
      await this.execFile('/bin/systemctl', ['is-enabled', 'serial-getty@serial0.service'], READINESS_COMMAND_OPTIONS);
    } catch {
      return;
    }
    throw new Error('serial console enabled');
  }
}
