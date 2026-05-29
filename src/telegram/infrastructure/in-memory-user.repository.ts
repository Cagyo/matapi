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
      createdAt: user.createdAt,
    };
    this.store.set(persisted.telegramId, persisted);
    return persisted;
  }

  async updateRole(telegramId: number, role: Role): Promise<User> {
    const existing = this.store.get(telegramId);
    if (!existing) throw new UserNotFoundError(String(telegramId));
    const updated: User = { ...existing, role };
    this.store.set(telegramId, updated);
    return updated;
  }

  async listRecipients(): Promise<User[]> {
    return [...this.store.values()];
  }
}
