export class InviteCodeUsedError extends Error {
  readonly code = 'INVITE_CODE_USED' as const;
  constructor(readonly value: string) {
    super(`Invite code '${value}' has already been used`);
    this.name = 'InviteCodeUsedError';
  }
}
