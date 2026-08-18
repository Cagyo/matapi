import { GpioBias } from './gpio-backend.port';

export const KNOWN_CHIP_LABELS = [
  'pinctrl-bcm2835', // Pi 0–3, Zero 2
  'pinctrl-bcm2711', // Pi 4, CM4
  'pinctrl-rp1', // Pi 5, 500, CM5
] as const;

export const GPIOMON_CONSUMER_PREFIX = 'home-worker-';
/**
 * Pinned event format for both majors — default output is never parsed.
 * `%e` prints the edge only; the level derives from it (rising=1, falling=0).
 * Also the distinctive token for orphan-sweep argv matching on v1, where the
 * consumer string is the fixed "gpiomon".
 */
export const GPIOMON_FORMAT_FLAG = '--format=%e';

export interface DetectedChip {
  name: string;
  label: string;
  lines: number;
}

export class LibgpiodSyntaxError extends Error {}

export function detectMajor(versionOutput: string): 1 | 2 {
  const match = /\bv?(\d+)\.\d+/.exec(versionOutput);
  if (!match) {
    throw new LibgpiodSyntaxError(`unrecognised libgpiod version output: ${versionOutput.trim()}`);
  }
  const major = Number(match[1]);
  if (major !== 1 && major !== 2) {
    throw new LibgpiodSyntaxError(`unsupported libgpiod major version ${major}`);
  }
  return major;
}

export function parseGpiodetect(stdout: string): DetectedChip[] {
  const chips: DetectedChip[] = [];
  for (const row of stdout.split('\n')) {
    const match = /^(\S+)\s+\[([^\]]*)\]\s+\((\d+) lines\)/.exec(row.trim());
    if (match) chips.push({ name: match[1], label: match[2], lines: Number(match[3]) });
  }
  return chips;
}

/** Resolve the chip by label, never by index — the RP1 chip moved between gpiochip4 and gpiochip0 across firmware releases. */
export function resolveChip(chips: DetectedChip[], override?: string): DetectedChip {
  if (override) {
    const chip = chips.find((candidate) => candidate.name === override || candidate.label === override);
    if (!chip) {
      throw new LibgpiodSyntaxError(`GPIO_CHIP override "${override}" matches no detected chip`);
    }
    return chip;
  }
  const chip = chips.find((candidate) =>
    (KNOWN_CHIP_LABELS as readonly string[]).includes(candidate.label),
  );
  if (!chip) {
    throw new LibgpiodSyntaxError(
      `no known GPIO chip label among: ${chips.map((candidate) => candidate.label).join(', ') || '(none)'}`,
    );
  }
  return chip;
}

export interface GpiodCliSyntax {
  readonly major: 1 | 2;
  gpiogetArgs(chip: string, offset: number, bias: GpioBias): string[];
  parseGpioget(stdout: string): 0 | 1;
  gpiomonArgs(chip: string, offset: number, bias: GpioBias, debounceUs: number): string[];
  /** Returns the raw level implied by one formatted event line, or null for non-event output. */
  parseGpiomonEvent(line: string): 0 | 1 | null;
  gpioinfoArgs(chip: string): string[];
  consumerOf(gpioinfoStdout: string, offset: number): string | null;
  /** Full-argv orphan signature match. PPID heuristics are deliberately not used. */
  isOurMonitorArgv(argv: string, chip: string, offset?: number): boolean;
}

function biasFlag(bias: GpioBias): string {
  switch (bias) {
    case 'up':
      return '--bias=pull-up';
    case 'down':
      return '--bias=pull-down';
    case 'none':
      return '--bias=disabled';
  }
}

function parseBit(stdout: string): 0 | 1 {
  const trimmed = stdout.trim();
  if (trimmed === '0') return 0;
  if (trimmed === '1') return 1;
  throw new LibgpiodSyntaxError(`unexpected gpioget output: ${JSON.stringify(stdout)}`);
}

function argvHasToken(argv: string, token: string): boolean {
  return argv.split(/\s+/u).includes(token);
}

const v1Syntax: GpiodCliSyntax = {
  major: 1,
  gpiogetArgs: (chip, offset, bias) => [biasFlag(bias), chip, String(offset)],
  parseGpioget: parseBit,
  // --debounce-period is v2-only; the caller logs-and-ignores debounceUs on v1.
  gpiomonArgs: (chip, offset, bias) => [biasFlag(bias), GPIOMON_FORMAT_FLAG, chip, String(offset)],
  parseGpiomonEvent: (line) => {
    const trimmed = line.trim();
    if (trimmed === '1') return 1;
    if (trimmed === '0') return 0;
    return null;
  },
  gpioinfoArgs: (chip) => [chip],
  consumerOf: (stdout, offset) => {
    for (const row of stdout.split('\n')) {
      // Lookahead, not \b: the quoted-consumer alternative ends on a closing
      // `"`, and `"` -> whitespace is a non-word -> non-word transition, so a
      // trailing \b never matches there. (?=\s|$) asserts "end of token"
      // without relying on \b's word-class boundary.
      const match =
        /^\s*line\s+(\d+):\s+(?:"[^"]*"|unnamed)\s+(?:"([^"]*)"|unused|kernel)(?=\s|$)/.exec(row);
      if (match && Number(match[1]) === offset) return match[2] ?? null;
    }
    return null;
  },
  isOurMonitorArgv: (argv, chip, offset) =>
    argv.includes('gpiomon') &&
    argvHasToken(argv, chip) &&
    argv.includes(GPIOMON_FORMAT_FLAG) &&
    (offset === undefined || argvHasToken(argv, String(offset))),
};

const v2Syntax: GpiodCliSyntax = {
  major: 2,
  gpiogetArgs: (chip, offset, bias) => ['--chip', chip, '--numeric', biasFlag(bias), String(offset)],
  parseGpioget: parseBit,
  gpiomonArgs: (chip, offset, bias, debounceUs) => {
    const args = [
      '--chip', chip, biasFlag(bias),
      `--consumer=${GPIOMON_CONSUMER_PREFIX}${offset}`,
      GPIOMON_FORMAT_FLAG,
    ];
    if (debounceUs > 0) args.push(`--debounce-period=${debounceUs}us`);
    args.push(String(offset));
    return args;
  },
  parseGpiomonEvent: (line) => {
    const trimmed = line.trim();
    // Provisional dual mapping until device fixtures pin the shape: word form,
    // or the numeric gpiod event codes (1 = rising, 2 = falling).
    if (trimmed === 'rising' || trimmed === '1') return 1;
    if (trimmed === 'falling' || trimmed === '2') return 0;
    return null;
  },
  gpioinfoArgs: (chip) => ['--chip', chip],
  consumerOf: (stdout, offset) => {
    for (const row of stdout.split('\n')) {
      const match = /^\s*line\s+(\d+):\s+"[^"]*"\s+(.*)$/.exec(row);
      if (match && Number(match[1]) === offset) {
        const consumer = /consumer="([^"]+)"/.exec(match[2]);
        return consumer ? consumer[1] : null;
      }
    }
    return null;
  },
  isOurMonitorArgv: (argv, chip, offset) =>
    argv.includes('gpiomon') &&
    argvHasToken(argv, chip) &&
    argv.includes(GPIOMON_FORMAT_FLAG) &&
    argv.includes(`--consumer=${GPIOMON_CONSUMER_PREFIX}`) &&
    (offset === undefined || argv.includes(`--consumer=${GPIOMON_CONSUMER_PREFIX}${offset}`)),
};

export function syntaxFor(major: 1 | 2): GpiodCliSyntax {
  return major === 1 ? v1Syntax : v2Syntax;
}
