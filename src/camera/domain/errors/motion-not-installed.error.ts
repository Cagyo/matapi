export class MotionNotInstalledError extends Error {
  readonly code = 'MOTION_NOT_INSTALLED' as const;
  constructor() {
    super('Motion is not installed');
    this.name = 'MotionNotInstalledError';
  }
}
