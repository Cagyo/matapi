export type InvalidQuietHoursReason = 'format' | 'time';

export class InvalidQuietHoursError extends Error {
  readonly code = 'INVALID_QUIET_HOURS' as const;
  constructor(readonly reason: InvalidQuietHoursReason) {
    super(`Invalid quiet hours: ${reason}`);
    this.name = 'InvalidQuietHoursError';
  }
}
