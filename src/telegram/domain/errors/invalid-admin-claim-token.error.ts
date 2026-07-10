export class InvalidAdminClaimTokenError extends Error {
  constructor() {
    super('Invalid admin claim token');
    this.name = 'InvalidAdminClaimTokenError';
  }
}
