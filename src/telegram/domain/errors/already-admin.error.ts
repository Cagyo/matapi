export class AlreadyAdminError extends Error {
  readonly code = 'ALREADY_ADMIN' as const;
  constructor(readonly name: string) {
    super(`${name} is already an admin`);
    this.name = 'AlreadyAdminError';
  }
}
