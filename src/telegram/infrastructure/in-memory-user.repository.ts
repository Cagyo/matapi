import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { UserRepositoryPort } from '../domain/ports/user-repository.port';
import { Role } from '../domain/role';
import { NewUser, User } from '../domain/user.entity';

/**
 * In-memory `UserRepositoryPort` — used in dev mode (`BOT_MODE=mock` or no
 * Telegram token) and in tests.
 */
export class InMemoryUserRepository implements UserRepositoryPort {
  private readonly store = new Map<number, User>();

  constructor(seed: User[] = []) {
    for (const user of seed) {
      this.store.set(user.telegramId, user);
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

  async findByName(name: string): Promise<User | null> {
    const needle = name.replace(/^@/, '').toLowerCase();
    if (!needle) return null;
    for (const user of this.store.values()) {
      if (user.name.toLowerCase() === needle) return user;
    }
    return null;
  }

  async createAdmin(user: NewUser): Promise<User> {
    const persisted: User = {
      telegramId: user.telegramId,
      name: user.name,
      role: user.role,
      muted: false,
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
      muted: false,
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
    const updated: User = { ...existing, muted };
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
}
