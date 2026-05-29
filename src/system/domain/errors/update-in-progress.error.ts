export class UpdateInProgressError extends Error {
  readonly code = 'UPDATE_IN_PROGRESS' as const;
  constructor() {
    super('Update already in progress');
    this.name = 'UpdateInProgressError';
  }
}
