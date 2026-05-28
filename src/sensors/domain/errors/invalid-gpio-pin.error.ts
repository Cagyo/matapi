export class InvalidGpioPinError extends Error {
  readonly code = 'INVALID_GPIO_PIN' as const;
  constructor(readonly pin: unknown) {
    super(`GPIO pin '${String(pin)}' is invalid (expected integer 0–27)`);
    this.name = 'InvalidGpioPinError';
  }
}
