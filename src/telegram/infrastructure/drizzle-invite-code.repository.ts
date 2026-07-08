import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { inviteCodes } from '../../database/schema';
import { InviteCode, NewInviteCode } from '../domain/invite-code.entity';
import { InviteCodeRepositoryPort } from '../domain/ports/invite-code-repository.port';
import { Role } from '../domain/role';

type InviteRow = typeof inviteCodes.$inferSelect;

@Injectable()
export class DrizzleInviteCodeRepository implements InviteCodeRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async create(invite: NewInviteCode): Promise<InviteCode> {
    const [row] = this.db
      .insert(inviteCodes)
      .values({
        code: invite.code,
        role: invite.role,
        createdBy: invite.createdBy,
        createdAt: invite.createdAt,
      })
      .returning()
      .all();
    return this.toEntity(row);
  }

  async findByCode(code: string): Promise<InviteCode | null> {
    const row = this.db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code))
      .get();
    return row ? this.toEntity(row) : null;
  }

  async redeem(
    code: string,
    usedBy: number,
    usedAt: Date,
  ): Promise<InviteCode | null> {
    const [row] = this.db
      .update(inviteCodes)
      .set({ usedBy, usedAt })
      .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedBy)))
      .returning()
      .all();
    return row ? this.toEntity(row) : null;
  }

  private toEntity(row: InviteRow): InviteCode {
    return {
      code: row.code,
      role: (row.role as Role) ?? 'user',
      createdBy: row.createdBy ?? null,
      usedBy: row.usedBy ?? null,
      createdAt: row.createdAt ?? null,
      usedAt: row.usedAt ?? null,
    };
  }
}
