import { Inject, Injectable } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { users } from '../../database/schema';
import { UserRepositoryPort } from '../domain/ports/user-repository.port';
import { Role } from '../domain/role';
import { NewUser, User } from '../domain/user.entity';

type UserRow = typeof users.$inferSelect;

@Injectable()
export class DrizzleUserRepository implements UserRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async countAdmins(): Promise<number> {
    const [{ value }] = this.db
      .select({ value: count() })
      .from(users)
      .where(eq(users.role, 'admin'))
      .all();
    return value;
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId))
      .get();
    return row ? this.toUser(row) : null;
  }

  async createAdmin(user: NewUser): Promise<User> {
    const [row] = this.db
      .insert(users)
      .values({
        telegramId: user.telegramId,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
      })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: { role: user.role, name: user.name },
      })
      .returning()
      .all();
    return this.toUser(row);
  }

  async listRecipients(): Promise<User[]> {
    return this.db
      .select()
      .from(users)
      .all()
      .map((row) => this.toUser(row));
  }

  private toUser(row: UserRow): User {
    return {
      telegramId: row.telegramId,
      name: row.name,
      role: (row.role as Role) ?? 'user',
      createdAt: row.createdAt ?? null,
    };
  }
}
