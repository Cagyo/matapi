export class NoCamerasConfiguredError extends Error {
  readonly code = 'NO_CAMERAS_CONFIGURED' as const;
  constructor() {
    super('No cameras configured');
    this.name = 'NoCamerasConfiguredError';
  }
}
