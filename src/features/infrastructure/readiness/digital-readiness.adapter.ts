import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import type { ManageableFeatureName } from '../../domain/manageable-feature';
import { Logger } from '@nestjs/common';
import { defaultExecFile, hasGroups, READINESS_COMMAND_OPTIONS, type FixedExecFile } from './readiness-seams';

export interface DigitalReadinessDependencies {
  execFile?: FixedExecFile;
}

const KNOWN_CHIP_LABELS = ['pinctrl-bcm2835', 'pinctrl-bcm2711', 'pinctrl-rp1'];

export class DigitalReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(DigitalReadinessAdapter.name);
  private readonly execFile: FixedExecFile;

  constructor(dependencies: DigitalReadinessDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
  }

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    let check = 'gpiodetect executable';
    try {
      await this.execFile('/usr/bin/which', ['gpiodetect'], READINESS_COMMAND_OPTIONS);

      check = 'gpio chip label';
      const detect = await this.execFile('/usr/bin/gpiodetect', [], READINESS_COMMAND_OPTIONS);
      const chip = knownChipName(detect.stdout);
      if (!chip) throw new Error('no known gpio chip label');

      check = 'gpio group membership';
      const groups = await this.execFile('/usr/bin/id', ['-nG'], READINESS_COMMAND_OPTIONS);
      if (!hasGroups(groups.stdout, ['gpio'])) throw new Error('worker not in gpio group');

      // Bare gpioinfo (no chip argument) is valid on both libgpiod majors and
      // proves the running supervisor's EFFECTIVE permissions, not merely that
      // a device node exists.
      check = 'gpio chip effective permissions';
      await this.execFile('/usr/bin/gpioinfo', [], READINESS_COMMAND_OPTIONS);

      // Not hygiene: pigpiod mmaps /dev/gpiomem — no gpiochip consumer, no
      // EBUSY — so a survivor silently fights our bias/debounce settings.
      // Its absence must be asserted positively.
      check = 'pigpiod absence';
      const pigpiodActive = await this.execFile(
        '/bin/systemctl',
        ['is-active', 'pigpiod.service'],
        READINESS_COMMAND_OPTIONS,
      ).then(
        () => true,
        () => false,
      );
      if (pigpiodActive) throw new Error('pigpiod is still active');

      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: digital ${check}`);
      return { ready: false, failureCode: 'application-verification-failed' };
    }
  }
}

function knownChipName(gpiodetectStdout: string): string | null {
  const override = process.env.GPIO_CHIP;
  for (const row of gpiodetectStdout.split('\n')) {
    const match = /^(\S+)\s+\[([^\]]+)\]/.exec(row.trim());
    if (!match) continue;
    if (KNOWN_CHIP_LABELS.includes(match[2])) return match[1];
    if (override && (match[1] === override || match[2] === override)) return match[1];
  }
  return null;
}
