export class AdminAlreadyClaimedError extends Error {
  readonly code = 'ADMIN_ALREADY_CLAIMED' as const;
  constructor() {
    super('This Home Worker already has an admin');
    this.name = 'AdminAlreadyClaimedError';
  }
}
