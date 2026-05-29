export class OtaCheckFailedError extends Error {
  readonly code = 'OTA_CHECK_FAILED' as const;
  constructor(readonly reason: string) {
    super(`OTA check failed: ${reason}`);
    this.name = 'OtaCheckFailedError';
  }
}
