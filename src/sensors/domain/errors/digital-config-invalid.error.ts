export class DigitalConfigInvalidError extends Error {
  readonly code = 'DIGITAL_CONFIG_INVALID' as const;
  constructor(readonly reason: string) {
    super(`Digital sensor config invalid: ${reason}`);
    this.name = 'DigitalConfigInvalidError';
  }
}
