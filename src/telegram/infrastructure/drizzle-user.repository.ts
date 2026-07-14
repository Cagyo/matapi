import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { notificationPauseReceipts, users } from '../../database/schema';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { normalizeLocale, Locale } from '../domain/locale';
import { UserRepositoryPort } from '../domain/ports/user-repository.port';
import {
  ApplyNonCriticalPauseCommand,
  ApplyNonCriticalPauseResult,
  CompareAndSetQuietHoursCommand,
  CompareAndSetQuietHoursResult,
  MAX_NOTIFICATION_PAUSE_RECEIPTS_PER_USER,
  NotificationPauseRepositoryPort,
  NotificationPauseState,
  ResumeNotificationsCommand,
  ResumeNotificationsResult,
  UndoNonCriticalPauseResult,
} from '../domain/ports/notification-pause-repository.port';
import { Role } from '../domain/role';
import { NewUser, User } from '../domain/user.entity';

type UserRow = typeof users.$inferSelect;

@Injectable()
export class DrizzleUserRepository
  implements UserRepositoryPort, NotificationPauseRepositoryPort
{
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
          locale: user.locale,
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
        locale: user.locale,
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
        locale: user.locale,
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
    // A real toggle bumps the pause revision so it supersedes any pending Undo;
    // a no-op mute leaves it unchanged. Single conditional UPDATE — no SELECT.
    const [row] = this.db
      .update(users)
      .set({
        muted,
        notificationPauseRevision: sql`${users.notificationPauseRevision} + (CASE WHEN ${users.muted} <> ${muted ? 1 : 0} THEN 1 ELSE 0 END)`,
      })
      .where(eq(users.telegramId, telegramId))
      .returning()
      .all();
    if (!row) throw new UserNotFoundError(String(telegramId));
    return this.toUser(row);
  }

  async setLocale(telegramId: number, locale: Locale): Promise<User> {
    const [row] = this.db
      .update(users)
      .set({ locale })
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

  // ─── NotificationPauseRepositoryPort ───

  async getNotificationPauseState(
    userId: number,
  ): Promise<NotificationPauseState | null> {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.telegramId, userId))
      .get();
    return row ? this.pauseStateOf(row) : null;
  }

  async applyNonCriticalPause(
    command: ApplyNonCriticalPauseCommand,
  ): Promise<ApplyNonCriticalPauseResult> {
    return this.db.transaction((tx): ApplyNonCriticalPauseResult => {
      const user = tx
        .select()
        .from(users)
        .where(eq(users.telegramId, command.userId))
        .get();
      if (!user) return { kind: 'not_found' };
      if (user.muted) return { kind: 'legacy_active' };
      if ((user.notificationPauseRevision ?? 0) !== command.expectedRevision) {
        return { kind: 'conflict' };
      }

      const previousPausedUntil = this.stillFuture(
        user.nonCriticalPausedUntil ?? null,
        command.now,
      )
        ? user.nonCriticalPausedUntil
        : null;
      const newRevision = command.expectedRevision + 1;

      const [updated] = tx
        .update(users)
        .set({
          nonCriticalPausedUntil: command.pausedUntil,
          notificationPauseRevision: newRevision,
        })
        .where(
          and(
            eq(users.telegramId, command.userId),
            eq(users.notificationPauseRevision, command.expectedRevision),
          ),
        )
        .returning()
        .all();
      if (!updated) return { kind: 'conflict' };

      const [receipt] = tx
        .insert(notificationPauseReceipts)
        .values({
          userId: command.userId,
          previousPausedUntil,
          appliedPausedUntil: command.pausedUntil,
          expectedRevision: newRevision,
          expiresAt: command.pausedUntil,
          consumedAt: null,
          createdAt: command.now,
        })
        .returning()
        .all();

      // Retention: keep only the newest 32 receipts for this user.
      const ids = tx
        .select({ id: notificationPauseReceipts.id })
        .from(notificationPauseReceipts)
        .where(eq(notificationPauseReceipts.userId, command.userId))
        .orderBy(desc(notificationPauseReceipts.id))
        .all()
        .map((r) => r.id);
      const evicted = ids.slice(MAX_NOTIFICATION_PAUSE_RECEIPTS_PER_USER);
      if (evicted.length > 0) {
        tx.delete(notificationPauseReceipts)
          .where(inArray(notificationPauseReceipts.id, evicted))
          .run();
      }

      return {
        kind: 'applied',
        state: this.pauseStateOf(updated),
        receiptId: receipt.id,
      };
    });
  }

  async resumeNotifications(
    command: ResumeNotificationsCommand,
  ): Promise<ResumeNotificationsResult> {
    return this.db.transaction((tx): ResumeNotificationsResult => {
      const user = tx
        .select()
        .from(users)
        .where(eq(users.telegramId, command.userId))
        .get();
      if (!user) return { kind: 'not_found' };
      if ((user.notificationPauseRevision ?? 0) !== command.expectedRevision) {
        return { kind: 'conflict' };
      }

      // Clearable by column presence, not runtime activity: a past deadline
      // still counts. Only when nothing is set is there no change.
      const changed = (user.muted ?? false) || user.nonCriticalPausedUntil !== null;
      if (!changed) {
        return { kind: 'applied', state: this.pauseStateOf(user), changed: false };
      }

      const [updated] = tx
        .update(users)
        .set({
          muted: false,
          nonCriticalPausedUntil: null,
          notificationPauseRevision: command.expectedRevision + 1,
        })
        .where(
          and(
            eq(users.telegramId, command.userId),
            eq(users.notificationPauseRevision, command.expectedRevision),
          ),
        )
        .returning()
        .all();
      if (!updated) return { kind: 'conflict' };
      return { kind: 'applied', state: this.pauseStateOf(updated), changed: true };
    });
  }

  async compareAndSetQuietHours(
    command: CompareAndSetQuietHoursCommand,
  ): Promise<CompareAndSetQuietHoursResult> {
    if ((command.start === null) !== (command.end === null)) {
      throw new RangeError('Quiet hours require both range ends or neither');
    }
    return this.db.transaction((tx): CompareAndSetQuietHoursResult => {
      const user = tx.select().from(users).where(eq(users.telegramId, command.userId)).get();
      if (!user) return { kind: 'not_found' };
      if ((user.notificationPauseRevision ?? 0) !== command.expectedRevision) return { kind: 'conflict' };
      const changed = (user.quietStart ?? null) !== command.start || (user.quietEnd ?? null) !== command.end;
      const updated = changed
        ? tx.update(users).set({ quietStart: command.start, quietEnd: command.end, notificationPauseRevision: command.expectedRevision + 1 }).where(and(eq(users.telegramId, command.userId), eq(users.notificationPauseRevision, command.expectedRevision))).returning().get()
        : user;
      if (!updated) return { kind: 'conflict' };
      return { kind: 'applied', changed, state: { ...this.pauseStateOf(updated), quietStart: updated.quietStart ?? null, quietEnd: updated.quietEnd ?? null } };
    }, { behavior: 'immediate' });
  }

  async undoNonCriticalPause(
    userId: number,
    receiptId: number,
    now: Date,
  ): Promise<UndoNonCriticalPauseResult> {
    return this.db.transaction((tx): UndoNonCriticalPauseResult => {
      const receipt = tx
        .select()
        .from(notificationPauseReceipts)
        .where(
          and(
            eq(notificationPauseReceipts.id, receiptId),
            eq(notificationPauseReceipts.userId, userId),
          ),
        )
        .get();
      if (!receipt) return { kind: 'not_found' };
      if (receipt.consumedAt !== null) return { kind: 'consumed' };

      const [{ latest }] = tx
        .select({ latest: max(notificationPauseReceipts.id) })
        .from(notificationPauseReceipts)
        .where(eq(notificationPauseReceipts.userId, userId))
        .all();
      if (latest !== receiptId) return { kind: 'superseded' };

      if (now.getTime() >= receipt.expiresAt.getTime()) return { kind: 'expired' };

      const user = tx
        .select()
        .from(users)
        .where(eq(users.telegramId, userId))
        .get();
      if (!user) return { kind: 'not_found' };
      if ((user.notificationPauseRevision ?? 0) !== receipt.expectedRevision) {
        return { kind: 'superseded' };
      }

      const restored = this.stillFuture(receipt.previousPausedUntil, now)
        ? receipt.previousPausedUntil
        : null;
      const [updated] = tx
        .update(users)
        .set({
          nonCriticalPausedUntil: restored,
          notificationPauseRevision: receipt.expectedRevision + 1,
        })
        .where(
          and(
            eq(users.telegramId, userId),
            eq(users.notificationPauseRevision, receipt.expectedRevision),
          ),
        )
        .returning()
        .all();
      if (!updated) return { kind: 'superseded' };

      tx.update(notificationPauseReceipts)
        .set({ consumedAt: now })
        .where(eq(notificationPauseReceipts.id, receiptId))
        .run();

      return { kind: 'applied', state: this.pauseStateOf(updated) };
    });
  }

  private pauseStateOf(row: UserRow): NotificationPauseState {
    return {
      userId: row.telegramId,
      legacyMuted: row.muted ?? false,
      nonCriticalPausedUntil: row.nonCriticalPausedUntil ?? null,
      revision: row.notificationPauseRevision ?? 0,
    };
  }

  private stillFuture(deadline: Date | null, now: Date): deadline is Date {
    return deadline !== null && deadline.getTime() > now.getTime();
  }

  private toUser(row: UserRow): User {
    return {
      telegramId: row.telegramId,
      name: row.name,
      role: (row.role as Role) ?? 'user',
      locale: normalizeLocale(row.locale),
      muted: row.muted ?? false,
      nonCriticalPausedUntil: row.nonCriticalPausedUntil ?? null,
      notificationPauseRevision: row.notificationPauseRevision ?? 0,
      quietStart: row.quietStart ?? null,
      quietEnd: row.quietEnd ?? null,
      createdAt: row.createdAt ?? null,
    };
  }
}
