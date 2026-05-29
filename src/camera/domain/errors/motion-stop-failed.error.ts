export class MotionStopFailedError extends Error {
  readonly code = 'MOTION_STOP_FAILED' as const;
  constructor(readonly reason: string) {
    super(`Failed to stop motion daemon: ${reason}`);
    this.name = 'MotionStopFailedError';
  }
}
