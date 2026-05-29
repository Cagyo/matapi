export class MotionStartFailedError extends Error {
  readonly code = 'MOTION_START_FAILED' as const;
  constructor(readonly reason: string) {
    super(`Failed to start motion daemon: ${reason}`);
    this.name = 'MotionStartFailedError';
  }
}
