export class LiveSourceCredentialConfigurationError extends Error {
  readonly code = 'LIVE_SOURCE_CREDENTIAL_CONFIGURATION_INVALID' as const;

  constructor() {
    super('Live source credential configuration is invalid');
    this.name = 'LiveSourceCredentialConfigurationError';
  }
}
