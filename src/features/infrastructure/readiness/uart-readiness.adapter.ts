import type { ManageableFeatureName } from '../../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import { Logger } from '@nestjs/common';
import { defaultExecFile, nodeReadinessFiles, READINESS_COMMAND_OPTIONS, type FixedExecFile } from './readiness-seams';

interface UartFiles {
  readFile(path: string): Promise<string>;
  openReadWrite(path: string): Promise<void>;
}

const SERIAL_GETTY_UNITS = [
  'serial-getty@serial0.service',
  'serial-getty@ttyAMA0.service',
  'serial-getty@ttyS0.service',
  'serial-getty@ttyAMA10.service',
] as const;
const SERIAL_CONSOLE_PATTERN = /(?:^|\s)console=(?:serial0|ttyAMA0|ttyS0|ttyAMA10)(?:,[^\s]*)?(?=\s|$)/u;

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
      const activeCmdline = await this.readActiveCmdline();
      if (SERIAL_CONSOLE_PATTERN.test(activeCmdline)) throw new Error('serial console active in kernel cmdline');
      const cmdline = await this.readBootCmdline();
      if (SERIAL_CONSOLE_PATTERN.test(cmdline)) throw new Error('serial console remains in cmdline');
      check = 'serial device access';
      await this.files.openReadWrite(this.serialDevice);
      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: uart ${check}`);
      return { ready: false, failureCode: 'application-verification-failed', reason: 'runtime-invalid' };
    }
  }

  private async readBootConfig(): Promise<string> {
    try {
      return await this.files.readFile('/boot/firmware/config.txt');
    } catch {
      return this.files.readFile('/boot/config.txt');
    }
  }

  private async readBootCmdline(): Promise<string> {
    try {
      return await this.files.readFile('/boot/firmware/cmdline.txt');
    } catch {
      return this.files.readFile('/boot/cmdline.txt');
    }
  }

  private readActiveCmdline(): Promise<string> {
    return this.files.readFile('/proc/cmdline');
  }

  private async assertConsoleDisabled(): Promise<void> {
    for (const unit of SERIAL_GETTY_UNITS) {
      const state = await this.execFile(
        '/bin/systemctl',
        ['show', unit, '--property=LoadState,UnitFileState,ActiveState'],
        READINESS_COMMAND_OPTIONS,
      );
      const values = new Map(
        state.stdout.trim().split(/\r?\n/u).flatMap((line) => {
          const separator = line.indexOf('=');
          return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
        }),
      );
      if (values.get('LoadState') === 'not-found') continue;
      if (
        values.get('LoadState') !== 'loaded' ||
        values.get('UnitFileState') !== 'disabled' ||
        values.get('ActiveState') !== 'inactive'
      ) {
        throw new Error('serial console enabled or unavailable');
      }
    }
  }
}
