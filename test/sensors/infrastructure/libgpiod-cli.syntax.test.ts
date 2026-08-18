import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectMajor,
  parseGpiodetect,
  resolveChip,
  syntaxFor,
  LibgpiodSyntaxError,
} from '../../../src/sensors/infrastructure/libgpiod-cli.syntax';

const fixture = (major: 'v1' | 'v2', name: string): string =>
  readFileSync(join(__dirname, '../../fixtures/gpio', major, `${name}.txt`), 'utf8');

describe('libgpiod-cli syntax', () => {
  describe('version detection', () => {
    it('detects v1 and v2 from real --version output', () => {
      expect(detectMajor(fixture('v1', 'version'))).toBe(1);
      expect(detectMajor(fixture('v2', 'version'))).toBe(2);
    });
    it('rejects unknown output', () => {
      expect(() => detectMajor('total garbage')).toThrow(LibgpiodSyntaxError);
      expect(() => detectMajor('gpiodetect (libgpiod) v3.0')).toThrow(LibgpiodSyntaxError);
    });
  });

  describe('chip resolution by label, never by index', () => {
    it('finds pinctrl-bcm2835 (Pi 3) and pinctrl-rp1 (Pi 5)', () => {
      expect(resolveChip(parseGpiodetect(fixture('v1', 'gpiodetect'))).name).toBe('gpiochip0');
      expect(resolveChip(parseGpiodetect(fixture('v2', 'gpiodetect'))).label).toBe('pinctrl-rp1');
    });
    it('honours a GPIO_CHIP override by name or label', () => {
      const chips = parseGpiodetect(fixture('v2', 'gpiodetect'));
      expect(resolveChip(chips, 'gpiochip10').name).toBe('gpiochip10');
      expect(resolveChip(chips, 'pinctrl-rp1').name).toBe('gpiochip0');
      expect(() => resolveChip(chips, 'gpiochip99')).toThrow(LibgpiodSyntaxError);
    });
    it('throws when no known label is present', () => {
      expect(() => resolveChip(parseGpiodetect('gpiochip0 [weird-chip] (8 lines)\n'))).toThrow(
        LibgpiodSyntaxError,
      );
    });
  });

  describe('v1 builders and parsers', () => {
    const v1 = syntaxFor(1);
    it('builds gpioget args with bias, chip-then-offset positional', () => {
      expect(v1.gpiogetArgs('gpiochip0', 17, 'up')).toEqual(['--bias=pull-up', 'gpiochip0', '17']);
      expect(v1.gpiogetArgs('gpiochip0', 17, 'none')).toEqual(['--bias=disabled', 'gpiochip0', '17']);
    });
    it('parses fixture gpioget output', () => {
      expect(v1.parseGpioget(fixture('v1', 'gpioget'))).toBe(0);
      expect(v1.parseGpioget('1\n')).toBe(1);
      expect(() => v1.parseGpioget('"GPIO17"=inactive\n')).toThrow(LibgpiodSyntaxError);
    });
    it('builds gpiomon args with pinned format and no debounce flag (v1 has none)', () => {
      expect(v1.gpiomonArgs('gpiochip0', 17, 'down', 10_000)).toEqual([
        '--bias=pull-down',
        '--format=%e',
        'gpiochip0',
        '17',
      ]);
    });
    it('parses fixture event lines and rejects noise', () => {
      const lines = fixture('v1', 'gpiomon-events').trim().split('\n');
      expect(lines.map((line) => v1.parseGpiomonEvent(line))).toEqual([1, 0, 1]);
      expect(v1.parseGpiomonEvent('')).toBeNull();
      expect(v1.parseGpiomonEvent('garbage')).toBeNull();
    });
    it('extracts the consumer of a held line from fixture gpioinfo', () => {
      const info = fixture('v1', 'gpioinfo');
      expect(v1.consumerOf(info, 17)).toBe('gpiomon');
      expect(v1.consumerOf(info, 18)).toBeNull();
    });
    it('matches our monitor argv signature, offset-filtered', () => {
      const argv = '/usr/bin/gpiomon --bias=pull-up --format=%e gpiochip0 17';
      expect(v1.isOurMonitorArgv(argv, 'gpiochip0')).toBe(true);
      expect(v1.isOurMonitorArgv(argv, 'gpiochip0', 17)).toBe(true);
      expect(v1.isOurMonitorArgv(argv, 'gpiochip0', 18)).toBe(false);
      // An administrator's manual gpiomon lacks our pinned format string.
      expect(v1.isOurMonitorArgv('gpiomon gpiochip0 17', 'gpiochip0', 17)).toBe(false);
    });
  });

  describe('v2 builders and parsers', () => {
    const v2 = syntaxFor(2);
    it('builds gpioget args with --chip and --numeric', () => {
      expect(v2.gpiogetArgs('gpiochip0', 17, 'up')).toEqual([
        '--chip', 'gpiochip0', '--numeric', '--bias=pull-up', '17',
      ]);
    });
    it('builds gpiomon args with consumer marker, format, and v2-only debounce', () => {
      expect(v2.gpiomonArgs('gpiochip0', 17, 'up', 10_000)).toEqual([
        '--chip', 'gpiochip0', '--bias=pull-up',
        '--consumer=home-worker-17', '--format=%e',
        '--debounce-period=10000us', '17',
      ]);
      expect(v2.gpiomonArgs('gpiochip0', 17, 'up', 0)).not.toContain('--debounce-period=0us');
    });
    it('parses fixture event lines (word and numeric forms)', () => {
      const lines = fixture('v2', 'gpiomon-events').trim().split('\n');
      expect(lines.map((line) => v2.parseGpiomonEvent(line))).toEqual([1, 0, 1]);
      expect(v2.parseGpiomonEvent('1')).toBe(1);
      expect(v2.parseGpiomonEvent('2')).toBe(0);
      expect(v2.parseGpiomonEvent('garbage')).toBeNull();
    });
    it('extracts the consumer from fixture gpioinfo', () => {
      const info = fixture('v2', 'gpioinfo');
      expect(v2.consumerOf(info, 17)).toBe('home-worker-17');
      expect(v2.consumerOf(info, 18)).toBeNull();
    });
    it('matches our monitor argv via the consumer marker', () => {
      const argv =
        '/usr/bin/gpiomon --chip gpiochip0 --bias=pull-up --consumer=home-worker-17 --format=%e --debounce-period=10000us 17';
      expect(v2.isOurMonitorArgv(argv, 'gpiochip0', 17)).toBe(true);
      expect(v2.isOurMonitorArgv(argv, 'gpiochip0', 18)).toBe(false);
      expect(v2.isOurMonitorArgv('gpiomon --chip gpiochip0 17', 'gpiochip0', 17)).toBe(false);
    });
  });
});
