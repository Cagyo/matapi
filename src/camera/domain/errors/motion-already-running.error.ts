export class MotionAlreadyRunningError extends Error {
  readonly code = 'MOTION_ALREADY_RUNNING' as const;
  constructor() {
    super('Motion daemon is already running');
    this.name = 'MotionAlreadyRunningError';
  }
}
