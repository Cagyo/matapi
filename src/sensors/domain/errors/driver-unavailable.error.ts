export class DriverUnavailableError extends Error {
  readonly code = 'DRIVER_UNAVAILABLE' as const;
  constructor(
    readonly driver: string,
    readonly reason: string,
  ) {
    super(`Driver '${driver}' is unavailable: ${reason}`);
    this.name = 'DriverUnavailableError';
  }
}
