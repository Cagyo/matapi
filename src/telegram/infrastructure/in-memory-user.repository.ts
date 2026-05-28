import { UserRepositoryPort } from '../domain/ports/user-repository.port';
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

  async listRecipients(): Promise<User[]> {
    return [...this.store.values()];
  }
}
