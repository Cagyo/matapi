export class NotAdminError extends Error {
  readonly code = 'NOT_ADMIN' as const;
  constructor(readonly name: string) {
    super(`${name} is already a regular user`);
    this.name = 'NotAdminError';
  }
}
