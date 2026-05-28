export class PinAlreadyInUseError extends Error {
  readonly code = 'PIN_ALREADY_IN_USE' as const;
  constructor(
    readonly pin: number,
    readonly owner: string,
  ) {
    super(`GPIO pin ${pin} is already used by sensor '${owner}'`);
    this.name = 'PinAlreadyInUseError';
  }
}
