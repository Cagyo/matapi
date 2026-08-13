export class DriveProviderCapacityBlockedError extends Error {
  readonly code = 'DRIVE_PROVIDER_CAPACITY_BLOCKED' as const;

  constructor(
    readonly kind: 'temporary' | 'user-action',
    readonly retryAfterMs: number | null = null,
  ) {
    super('Drive provider capacity is unavailable');
    this.name = 'DriveProviderCapacityBlockedError';
  }
}
