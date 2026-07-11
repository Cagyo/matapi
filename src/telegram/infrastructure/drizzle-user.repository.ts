import { Inject, Injectable } from '@nestjs/common';
import { count, eq, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { users } from '../../database/schema';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
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

  async claimFirstAdmin(user: NewUser): Promise<User | null> {
    return this.db.transaction((tx) => {
      const [{ value }] = tx
        .select({ value: count() })
        .from(users)
        .where(eq(users.role, 'admin'))
        .all();
      if (value > 0) return null;

      const [row] = tx
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
    });
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId))
      .get();
    return row ? this.toUser(row) : null;
  }

  async findByName(name: string): Promise<User[]> {
    const needle = name.replace(/^@/, '').toLowerCase();
    if (!needle) return [];
    return this.db
      .select()
      .from(users)
      .where(sql`LOWER(${users.name}) = ${needle}`)
      .all()
      .map((row) => this.toUser(row));
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

  async createUser(user: NewUser): Promise<User> {
    const [row] = this.db
      .insert(users)
      .values({
        telegramId: user.telegramId,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
      })
      .returning()
      .all();
    return this.toUser(row);
  }

  async demoteAdminIfNotLast(telegramId: number): Promise<User | null> {
    return this.db.transaction((tx) => {
      const [{ value }] = tx
        .select({ value: count() })
        .from(users)
        .where(eq(users.role, 'admin'))
        .all();
      if (value <= 1) return null;

      const [row] = tx
        .update(users)
        .set({ role: 'user' })
        .where(eq(users.telegramId, telegramId))
        .returning()
        .all();
      return row ? this.toUser(row) : null;
    });
  }

  async updateRole(telegramId: number, role: Role): Promise<User> {
    const [row] = this.db
      .update(users)
      .set({ role })
      .where(eq(users.telegramId, telegramId))
      .returning()
      .all();
    if (!row) throw new UserNotFoundError(String(telegramId));
    return this.toUser(row);
  }

  async setMuted(telegramId: number, muted: boolean): Promise<User> {
    const [row] = this.db
      .update(users)
      .set({ muted })
      .where(eq(users.telegramId, telegramId))
      .returning()
      .all();
    if (!row) throw new UserNotFoundError(String(telegramId));
    return this.toUser(row);
  }

  async setQuietHours(
    telegramId: number,
    start: string | null,
    end: string | null,
  ): Promise<User> {
    const [row] = this.db
      .update(users)
      .set({ quietStart: start, quietEnd: end })
      .where(eq(users.telegramId, telegramId))
      .returning()
      .all();
    if (!row) throw new UserNotFoundError(String(telegramId));
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
      muted: row.muted ?? false,
      quietStart: row.quietStart ?? null,
      quietEnd: row.quietEnd ?? null,
      createdAt: row.createdAt ?? null,
    };
  }
}
