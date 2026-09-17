export class LiveViewSetupRequiredError extends Error {
  readonly code = 'LIVE_VIEW_SETUP_REQUIRED' as const;

  constructor() {
    super('Complete Live view setup first');
    this.name = 'LiveViewSetupRequiredError';
  }
}
