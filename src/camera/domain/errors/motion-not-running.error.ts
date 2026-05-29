export class MotionNotRunningError extends Error {
  readonly code = 'MOTION_NOT_RUNNING' as const;
  constructor() {
    super('Motion daemon is not running');
    this.name = 'MotionNotRunningError';
  }
}
