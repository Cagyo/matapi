import { InvalidInviteCodeError } from '../domain/errors/invalid-invite-code.error';
import { InviteCode, NewInviteCode } from '../domain/invite-code.entity';
import { InviteCodeRepositoryPort } from '../domain/ports/invite-code-repository.port';

export class InMemoryInviteCodeRepository implements InviteCodeRepositoryPort {
  private readonly store = new Map<string, InviteCode>();

  constructor(seed: InviteCode[] = []) {
    for (const invite of seed) this.store.set(invite.code, invite);
  }

  async create(invite: NewInviteCode): Promise<InviteCode> {
    const persisted: InviteCode = {
      code: invite.code,
      role: invite.role,
      createdBy: invite.createdBy,
      createdAt: invite.createdAt,
      usedBy: null,
      usedAt: null,
    };
    this.store.set(persisted.code, persisted);
    return persisted;
  }

  async findByCode(code: string): Promise<InviteCode | null> {
    return this.store.get(code) ?? null;
  }

  async markUsed(code: string, usedBy: number, usedAt: Date): Promise<InviteCode> {
    const existing = this.store.get(code);
    if (!existing) throw new InvalidInviteCodeError(code);
    const updated: InviteCode = { ...existing, usedBy, usedAt };
    this.store.set(code, updated);
    return updated;
  }
}
