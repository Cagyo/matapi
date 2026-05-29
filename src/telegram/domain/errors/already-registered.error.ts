export class AlreadyRegisteredError extends Error {
  readonly code = 'ALREADY_REGISTERED' as const;
  constructor(readonly telegramId: number) {
    super(`User ${telegramId} is already registered`);
    this.name = 'AlreadyRegisteredError';
  }
}
