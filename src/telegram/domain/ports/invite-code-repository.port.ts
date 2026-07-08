import { InviteCode, NewInviteCode } from '../invite-code.entity';

export const INVITE_CODE_REPOSITORY = Symbol('INVITE_CODE_REPOSITORY');

export interface InviteCodeRepositoryPort {
  create(invite: NewInviteCode): Promise<InviteCode>;
  findByCode(code: string): Promise<InviteCode | null>;
  /**
   * Atomically consume an unused code. Returns the updated code, or `null` if
   * the code is missing or already used — a single conditional UPDATE, so a
   * code cannot be redeemed twice under concurrency (spec 11).
   */
  redeem(code: string, usedBy: number, usedAt: Date): Promise<InviteCode | null>;
}
