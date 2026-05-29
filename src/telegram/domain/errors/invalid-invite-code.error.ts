export class InvalidInviteCodeError extends Error {
  readonly code = 'INVALID_INVITE_CODE' as const;
  constructor(readonly value: string) {
    super(`Invite code '${value}' is invalid`);
    this.name = 'InvalidInviteCodeError';
  }
}
