import { describe, expect, it } from 'vitest';
import { PromoteUserUseCase } from '../../../src/telegram/application/promote-user.use-case';
import { AlreadyAdminError } from '../../../src/telegram/domain/errors/already-admin.error';
import { UserNotFoundError } from '../../../src/telegram/domain/errors/user-not-found.error';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

describe('PromoteUserUseCase', () => {
  it('promotes a regular user to admin', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 2002,
        name: 'Alex',
        role: 'user',
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);
    const useCase = new PromoteUserUseCase(users);

    const promoted = await useCase.execute('Alex');

    expect(promoted.role).toBe('admin');
    expect(promoted.telegramId).toBe(2002);
  });

  it('matches names case-insensitively and strips a leading @', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 2002,
        name: 'Alex',
        role: 'user',
        createdAt: null,
      },
    ]);
    const useCase = new PromoteUserUseCase(users);

    const promoted = await useCase.execute('@alex');
    expect(promoted.role).toBe('admin');
  });

  it('throws UserNotFoundError when the target is unknown', async () => {
    const useCase = new PromoteUserUseCase(new InMemoryUserRepository());
    await expect(useCase.execute('ghost')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('throws AlreadyAdminError when the target is already admin', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 1001,
        name: 'Ada',
        role: 'admin',
        createdAt: null,
      },
    ]);
    const useCase = new PromoteUserUseCase(users);
    await expect(useCase.execute('Ada')).rejects.toBeInstanceOf(
      AlreadyAdminError,
    );
  });
});
