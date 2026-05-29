export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND' as const;
  constructor(readonly query: string) {
    super(`User '${query}' not found`);
    this.name = 'UserNotFoundError';
  }
}
