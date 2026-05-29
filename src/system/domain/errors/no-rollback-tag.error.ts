export class NoRollbackTagError extends Error {
  readonly code = 'NO_ROLLBACK_TAG' as const;
  constructor() {
    super('No rollback tag available');
    this.name = 'NoRollbackTagError';
  }
}
