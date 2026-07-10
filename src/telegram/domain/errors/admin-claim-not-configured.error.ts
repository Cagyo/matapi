export class AdminClaimNotConfiguredError extends Error {
  constructor() {
    super('Admin claim token is not configured');
    this.name = 'AdminClaimNotConfiguredError';
  }
}
