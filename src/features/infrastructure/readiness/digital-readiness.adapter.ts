import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import type { ManageableFeatureName } from '../../domain/manageable-feature';
import { Logger } from '@nestjs/common';
import { defaultExecFile, hasGroups, nodeReadinessFiles, READINESS_COMMAND_OPTIONS, type FixedExecFile } from './readiness-seams';

interface DigitalFiles {
  openReadWrite(path: string): Promise<void>;
}

export interface DigitalReadinessDependencies {
  execFile?: FixedExecFile;
  files?: DigitalFiles;
}

const KNOWN_CHIP_LABELS = ['pinctrl-bcm2835', 'pinctrl-bcm2711', 'pinctrl-rp1'];

export class DigitalReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(DigitalReadinessAdapter.name);
  private readonly execFile: FixedExecFile;
  private readonly files: DigitalFiles;

  constructor(dependencies: DigitalReadinessDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
    this.files = dependencies.files ?? nodeReadinessFiles;
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

      // Step 2's gpiodetect already proved a gpiod subprocess under the sanitized
      // PATH can open and ioctl every chip. This open proves THIS process's
      // effective credentials against the specific chardev its gpiomon children
      // inherit by fork/exec: both libgpiod majors open the chip O_RDWR|O_CLOEXEC,
      // and the discretionary check — group ownership, udev rule, ACLs — happens
      // at open(), not at ioctl time. Scoped to the resolved chip on purpose:
      // bare `gpioinfo` walked ALL chips, so an unopenable gpio-brcmstb chip we
      // never drive failed readiness for a healthy pinctrl-rp1. No subprocess,
      // no output buffer, no size sensitivity.
      check = 'gpio chip effective permissions';
      await this.files.openReadWrite(`/dev/${chip}`);

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
    } catch (error) {
      this.logger.warn(`Feature readiness failed: digital ${check}: ${error instanceof Error ? error.message : String(error)}`);
      return { ready: false, failureCode: 'application-verification-failed' };
    }
  }
}

/**
 * Override-first, mirroring resolveChip() in
 * src/sensors/infrastructure/libgpiod-cli.syntax.ts. Never resolve by index: the
 * RP1 chip moved between gpiochip4 and gpiochip0 across firmware releases. A
 * GPIO_CHIP that matches nothing resolves to null (readiness fails) rather than
 * falling back to a known label — resolveChip() throws in that case, and a
 * divergence here would pass readiness on a chip the sensors then fail on.
 */
function knownChipName(gpiodetectStdout: string): string | null {
  const chips: Array<{ name: string; label: string }> = [];
  for (const row of gpiodetectStdout.split('\n')) {
    const match = /^(\S+)\s+\[([^\]]+)\]/.exec(row.trim());
    if (match) chips.push({ name: match[1], label: match[2] });
  }

  const override = process.env.GPIO_CHIP;
  if (override) {
    return chips.find((chip) => chip.name === override || chip.label === override)?.name ?? null;
  }
  return chips.find((chip) => KNOWN_CHIP_LABELS.includes(chip.label))?.name ?? null;
}
