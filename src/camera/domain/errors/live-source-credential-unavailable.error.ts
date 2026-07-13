export class LiveSourceCredentialUnavailableError extends Error {
  readonly code = 'LIVE_SOURCE_CREDENTIAL_UNAVAILABLE' as const;

  constructor() {
    super('Live source credential is unavailable');
    this.name = 'LiveSourceCredentialUnavailableError';
  }
}
