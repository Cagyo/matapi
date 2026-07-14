import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { DEFAULT_LOCALE, Locale } from '../domain/locale';
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

/** Internal receipt record; mirrors the `notification_pause_receipts` row. */
interface InMemoryPauseReceipt {
  id: number;
  userId: number;
  previousPausedUntil: Date | null;
  appliedPausedUntil: Date;
  expectedRevision: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/**
 * In-memory `UserRepositoryPort` + `NotificationPauseRepositoryPort` — used in
 * dev mode (`BOT_MODE=mock` or no Telegram token) and in tests. Implementing
 * both ports on one instance keeps recipient reads and pause mutations from
 * diverging, exactly as the Drizzle adapter does in production.
 */
export class InMemoryUserRepository
  implements UserRepositoryPort, NotificationPauseRepositoryPort
{
  private readonly store = new Map<number, User>();
  private readonly receipts = new Map<number, InMemoryPauseReceipt>();
  private nextReceiptId = 1;

  constructor(seed: User[] = []) {
    for (const user of seed) {
      this.store.set(user.telegramId, {
        ...user,
        locale: user.locale ?? DEFAULT_LOCALE,
        nonCriticalPausedUntil: user.nonCriticalPausedUntil ?? null,
        notificationPauseRevision: user.notificationPauseRevision ?? 0,
      });
    }
  }

  async countAdmins(): Promise<number> {
    let count = 0;
    for (const user of this.store.values()) {
      if (user.role === 'admin') count += 1;
    }
    return count;
  }

  async claimFirstAdmin(user: NewUser): Promise<User | null> {
    for (const existing of this.store.values()) {
      if (existing.role === 'admin') return null;
    }
    return this.createAdmin(user);
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    return this.store.get(telegramId) ?? null;
  }

  async findByName(name: string): Promise<User[]> {
    const needle = name.replace(/^@/, '').toLowerCase();
    if (!needle) return [];
    return [...this.store.values()].filter(
      (user) => user.name.toLowerCase() === needle,
    );
  }

  async createAdmin(user: NewUser): Promise<User> {
    const existing = this.store.get(user.telegramId);
    const persisted: User = {
      telegramId: user.telegramId,
      name: user.name,
      role: user.role,
      locale: existing?.locale ?? user.locale ?? DEFAULT_LOCALE,
      muted: false,
      nonCriticalPausedUntil: null,
      notificationPauseRevision: 0,
      quietStart: null,
      quietEnd: null,
      createdAt: user.createdAt,
    };
    this.store.set(persisted.telegramId, persisted);
    return persisted;
  }

  async createUser(user: NewUser): Promise<User> {
    const persisted: User = {
      telegramId: user.telegramId,
      name: user.name,
      role: user.role,
      locale: user.locale ?? DEFAULT_LOCALE,
      muted: false,
      nonCriticalPausedUntil: null,
      notificationPauseRevision: 0,
      quietStart: null,
      quietEnd: null,
      createdAt: user.createdAt,
    };
    this.store.set(persisted.telegramId, persisted);
    return persisted;
  }

  async demoteAdminIfNotLast(telegramId: number): Promise<User | null> {
    const existing = this.store.get(telegramId);
    if (!existing) throw new UserNotFoundError(String(telegramId));

    let adminCount = 0;
    for (const user of this.store.values()) {
      if (user.role === 'admin') adminCount += 1;
    }
    if (existing.role !== 'admin' || adminCount <= 1) return null;

    const updated: User = { ...existing, role: 'user' };
    this.store.set(telegramId, updated);
    return updated;
  }

  async updateRole(telegramId: number, role: Role): Promise<User> {
    const existing = this.store.get(telegramId);
    if (!existing) throw new UserNotFoundError(String(telegramId));
    const updated: User = { ...existing, role };
    this.store.set(telegramId, updated);
    return updated;
  }

  async setMuted(telegramId: number, muted: boolean): Promise<User> {
    const existing = this.store.get(telegramId);
    if (!existing) throw new UserNotFoundError(String(telegramId));
    // A real toggle bumps the pause revision so it supersedes any pending Undo.
    const changed = existing.muted !== muted;
    const updated: User = {
      ...existing,
      muted,
      notificationPauseRevision:
        existing.notificationPauseRevision + (changed ? 1 : 0),
    };
    this.store.set(telegramId, updated);
    return updated;
  }

  async setLocale(telegramId: number, locale: Locale): Promise<User> {
    const existing = this.store.get(telegramId);
    if (!existing) throw new UserNotFoundError(String(telegramId));
    const updated: User = { ...existing, locale };
    this.store.set(telegramId, updated);
    return updated;
  }

  async setQuietHours(
    telegramId: number,
    start: string | null,
    end: string | null,
  ): Promise<User> {
    const existing = this.store.get(telegramId);
    if (!existing) throw new UserNotFoundError(String(telegramId));
    const updated: User = { ...existing, quietStart: start, quietEnd: end };
    this.store.set(telegramId, updated);
    return updated;
  }

  async listRecipients(): Promise<User[]> {
    return [...this.store.values()];
  }

  /** Infrastructure-only transaction seam used by the paired Home receipt adapter. */
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const users = new Map([...this.store].map(([id, user]) => [id, { ...user }]));
    const receipts = new Map([...this.receipts].map(([id, receipt]) => [id, {
      ...receipt,
      previousPausedUntil: receipt.previousPausedUntil && new Date(receipt.previousPausedUntil),
      appliedPausedUntil: new Date(receipt.appliedPausedUntil),
      expiresAt: new Date(receipt.expiresAt),
      consumedAt: receipt.consumedAt && new Date(receipt.consumedAt),
      createdAt: new Date(receipt.createdAt),
    }]));
    const nextReceiptId = this.nextReceiptId;
    try {
      return await operation();
    } catch (error) {
      this.store.clear();
      for (const [id, user] of users) this.store.set(id, user);
      this.receipts.clear();
      for (const [id, receipt] of receipts) this.receipts.set(id, receipt);
      this.nextReceiptId = nextReceiptId;
      throw error;
    }
  }

  // ─── NotificationPauseRepositoryPort ───

  async getNotificationPauseState(
    userId: number,
  ): Promise<NotificationPauseState | null> {
    const user = this.store.get(userId);
    if (!user) return null;
    return this.stateOf(user);
  }

  async applyNonCriticalPause(
    command: ApplyNonCriticalPauseCommand,
  ): Promise<ApplyNonCriticalPauseResult> {
    const user = this.store.get(command.userId);
    if (!user) return { kind: 'not_found' };
    if (user.muted) return { kind: 'legacy_active' };
    if (user.notificationPauseRevision !== command.expectedRevision) {
      return { kind: 'conflict' };
    }

    // Only a still-future previous deadline is worth restoring later.
    const previousPausedUntil = this.stillFuture(
      user.nonCriticalPausedUntil,
      command.now,
    )
      ? user.nonCriticalPausedUntil
      : null;
    const revision = user.notificationPauseRevision + 1;
    this.store.set(command.userId, {
      ...user,
      nonCriticalPausedUntil: command.pausedUntil,
      notificationPauseRevision: revision,
    });

    const receipt: InMemoryPauseReceipt = {
      id: this.nextReceiptId++,
      userId: command.userId,
      previousPausedUntil,
      appliedPausedUntil: command.pausedUntil,
      expectedRevision: revision,
      expiresAt: command.pausedUntil,
      consumedAt: null,
      createdAt: command.now,
    };
    this.receipts.set(receipt.id, receipt);
    this.pruneReceipts(command.userId);

    return {
      kind: 'applied',
      state: this.stateOf(this.store.get(command.userId)!),
      receiptId: receipt.id,
    };
  }

  async resumeNotifications(
    command: ResumeNotificationsCommand,
  ): Promise<ResumeNotificationsResult> {
    const user = this.store.get(command.userId);
    if (!user) return { kind: 'not_found' };
    if (user.notificationPauseRevision !== command.expectedRevision) {
      return { kind: 'conflict' };
    }

    // Clearable by column presence, not runtime activity: a past deadline still
    // counts. Only when nothing is set is there no change.
    const changed = user.muted || user.nonCriticalPausedUntil !== null;
    if (!changed) {
      return { kind: 'applied', state: this.stateOf(user), changed: false };
    }

    const updated: User = {
      ...user,
      muted: false,
      nonCriticalPausedUntil: null,
      notificationPauseRevision: user.notificationPauseRevision + 1,
    };
    this.store.set(command.userId, updated);
    return { kind: 'applied', state: this.stateOf(updated), changed: true };
  }

  async compareAndSetQuietHours(
    command: CompareAndSetQuietHoursCommand,
  ): Promise<CompareAndSetQuietHoursResult> {
    if ((command.start === null) !== (command.end === null)) {
      throw new RangeError('Quiet hours require both range ends or neither');
    }
    const user = this.store.get(command.userId);
    if (!user) return { kind: 'not_found' };
    if (user.notificationPauseRevision !== command.expectedRevision) {
      return { kind: 'conflict' };
    }
    const changed = user.quietStart !== command.start || user.quietEnd !== command.end;
    const updated = changed
      ? { ...user, quietStart: command.start, quietEnd: command.end, notificationPauseRevision: user.notificationPauseRevision + 1 }
      : user;
    this.store.set(command.userId, updated);
    return { kind: 'applied', changed, state: this.quietHoursStateOf(updated) };
  }

  async undoNonCriticalPause(
    userId: number,
    receiptId: number,
    now: Date,
  ): Promise<UndoNonCriticalPauseResult> {
    const receipt = this.receipts.get(receiptId);
    if (receipt?.userId !== userId) return { kind: 'not_found' };
    if (receipt.consumedAt !== null) return { kind: 'consumed' };
    if (receiptId !== this.latestReceiptId(userId)) return { kind: 'superseded' };
    if (now.getTime() >= receipt.expiresAt.getTime()) return { kind: 'expired' };

    const user = this.store.get(userId);
    if (!user) return { kind: 'not_found' };
    if (user.notificationPauseRevision !== receipt.expectedRevision) {
      return { kind: 'superseded' };
    }

    const restored = this.stillFuture(receipt.previousPausedUntil, now)
      ? receipt.previousPausedUntil
      : null;
    const updated: User = {
      ...user,
      nonCriticalPausedUntil: restored,
      notificationPauseRevision: user.notificationPauseRevision + 1,
    };
    this.store.set(userId, updated);
    this.receipts.set(receiptId, { ...receipt, consumedAt: now });

    return { kind: 'applied', state: this.stateOf(updated) };
  }

  private stateOf(user: User): NotificationPauseState {
    return {
      userId: user.telegramId,
      legacyMuted: user.muted,
      nonCriticalPausedUntil: user.nonCriticalPausedUntil,
      revision: user.notificationPauseRevision,
    };
  }

  private quietHoursStateOf(user: User) {
    return { ...this.stateOf(user), quietStart: user.quietStart, quietEnd: user.quietEnd };
  }

  private stillFuture(deadline: Date | null, now: Date): deadline is Date {
    return deadline !== null && deadline.getTime() > now.getTime();
  }

  private userReceiptIds(userId: number): number[] {
    const ids: number[] = [];
    for (const receipt of this.receipts.values()) {
      if (receipt.userId === userId) ids.push(receipt.id);
    }
    return ids;
  }

  private latestReceiptId(userId: number): number | null {
    const ids = this.userReceiptIds(userId);
    return ids.length ? Math.max(...ids) : null;
  }

  /** Keep only the newest `MAX_…` receipts for one user; never prune others. */
  private pruneReceipts(userId: number): void {
    const ids = this.userReceiptIds(userId).sort((a, b) => b - a);
    for (const id of ids.slice(MAX_NOTIFICATION_PAUSE_RECEIPTS_PER_USER)) {
      this.receipts.delete(id);
    }
  }
}
