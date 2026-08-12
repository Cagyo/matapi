export type ApplicationLogUnavailableReason =
  | 'pm2-unavailable'
  | 'pm2-metadata-invalid'
  | 'process-not-found'
  | 'process-ambiguous'
  | 'stream-path-invalid'
  | 'stream-path-collision'
  | 'file-unavailable'
  | 'snapshot-too-large'
  | 'snapshot-changed'
  | 'sanitization-unsafe';

export class ApplicationLogUnavailableError extends Error {
  readonly code = 'APPLICATION_LOG_UNAVAILABLE' as const;

  constructor(readonly reason: ApplicationLogUnavailableReason) {
    super('Application logs are unavailable');
    this.name = 'ApplicationLogUnavailableError';
  }
}
