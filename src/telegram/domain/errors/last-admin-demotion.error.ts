export class LastAdminDemotionError extends Error {
  readonly code = 'LAST_ADMIN_DEMOTION' as const;

  constructor() {
    super('Cannot demote the final admin');
    this.name = 'LastAdminDemotionError';
  }
}
