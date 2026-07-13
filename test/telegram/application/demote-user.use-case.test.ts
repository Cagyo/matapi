import { describe, expect, it } from 'vitest';
import { DemoteUserUseCase } from '../../../src/telegram/application/demote-user.use-case';
import { ResolveUserTargetUseCase } from '../../../src/telegram/application/resolve-user-target.use-case';
import { LastAdminDemotionError } from '../../../src/telegram/domain/errors/last-admin-demotion.error';
import { NotAdminError } from '../../../src/telegram/domain/errors/not-admin.error';
import { UserNotFoundError } from '../../../src/telegram/domain/errors/user-not-found.error';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { User } from '../../../src/telegram/domain/user.entity';

function seedUser(overrides: Partial<User> & Pick<User, 'telegramId' | 'name' | 'role'>): User {
  return {
    locale: 'en',
    muted: false,
    nonCriticalPausedUntil: null,
    notificationPauseRevision: 0,
    quietStart: null,
    quietEnd: null,
    createdAt: null,
    ...overrides,
  };
}

describe('DemoteUserUseCase', () => {
  it('demotes an admin to a regular user when another admin remains', async () => {
    const users = new InMemoryUserRepository([
      seedUser({ telegramId: 1001, name: 'Ada', role: 'admin' }),
      seedUser({ telegramId: 1002, name: 'Linus', role: 'admin' }),
    ]);
    const useCase = new DemoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );

    const demoted = await useCase.execute('Ada');

    expect(demoted.role).toBe('user');
    expect(await users.countAdmins()).toBe(1);
  });

  it('rejects demotion of the final admin', async () => {
    const users = new InMemoryUserRepository([
      seedUser({ telegramId: 1001, name: 'Ada', role: 'admin' }),
    ]);
    const useCase = new DemoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );

    await expect(useCase.execute('Ada')).rejects.toBeInstanceOf(
      LastAdminDemotionError,
    );
    expect(await users.countAdmins()).toBe(1);
  });

  it('throws UserNotFoundError for unknown target', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new DemoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );
    await expect(useCase.execute('ghost')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('throws NotAdminError when target is already a regular user', async () => {
    const users = new InMemoryUserRepository([
      seedUser({ telegramId: 2002, name: 'Alex', role: 'user' }),
    ]);
    const useCase = new DemoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );
    await expect(useCase.execute('Alex')).rejects.toBeInstanceOf(NotAdminError);
  });

  it('demotes only the immutable id selected by id: syntax', async () => {
    const users = new InMemoryUserRepository([
      seedUser({ telegramId: 1, name: 'Admin', role: 'admin' }),
      seedUser({ telegramId: 1001, name: 'Alex', role: 'admin' }),
      seedUser({ telegramId: 1002, name: 'alex', role: 'admin' }),
    ]);
    const useCase = new DemoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );

    await useCase.execute('id:1002');
    expect((await users.findByTelegramId(1001))?.role).toBe('admin');
    expect((await users.findByTelegramId(1002))?.role).toBe('user');
  });
});
