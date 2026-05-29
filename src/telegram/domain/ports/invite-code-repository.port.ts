import { InviteCode, NewInviteCode } from '../invite-code.entity';

export const INVITE_CODE_REPOSITORY = Symbol('INVITE_CODE_REPOSITORY');

export interface InviteCodeRepositoryPort {
  create(invite: NewInviteCode): Promise<InviteCode>;
  findByCode(code: string): Promise<InviteCode | null>;
  markUsed(code: string, usedBy: number, usedAt: Date): Promise<InviteCode>;
}
