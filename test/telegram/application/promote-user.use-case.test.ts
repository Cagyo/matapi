import { describe, expect, it } from 'vitest';
import { PromoteUserUseCase } from '../../../src/telegram/application/promote-user.use-case';
import { ResolveUserTargetUseCase } from '../../../src/telegram/application/resolve-user-target.use-case';
import { AlreadyAdminError } from '../../../src/telegram/domain/errors/already-admin.error';
import { AmbiguousUserTargetError } from '../../../src/telegram/domain/errors/ambiguous-user-target.error';
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
    const useCase = new PromoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );

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
    const useCase = new PromoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );

    const promoted = await useCase.execute('@alex');
    expect(promoted.role).toBe('admin');
  });

  it('throws UserNotFoundError when the target is unknown', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new PromoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );
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
    const useCase = new PromoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );
    await expect(useCase.execute('Ada')).rejects.toBeInstanceOf(
      AlreadyAdminError,
    );
  });

  it('rejects an ambiguous name without changing either role', async () => {
    const users = new InMemoryUserRepository([
      { telegramId: 1001, name: 'Alex', role: 'user', createdAt: null },
      { telegramId: 1002, name: 'alex', role: 'user', createdAt: null },
    ]);
    const useCase = new PromoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );

    await expect(useCase.execute('@ALEX')).rejects.toBeInstanceOf(
      AmbiguousUserTargetError,
    );
    expect((await users.findByTelegramId(1001))?.role).toBe('user');
    expect((await users.findByTelegramId(1002))?.role).toBe('user');
  });

  it('retains only safe candidate fields for an ambiguous target', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 1001,
        name: 'Alex',
        role: 'user',
        muted: true,
        quietStart: '22:00',
        quietEnd: '07:00',
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      },
      {
        telegramId: 1002,
        name: 'alex',
        role: 'admin',
        muted: false,
        quietStart: null,
        quietEnd: null,
        createdAt: new Date('2030-01-02T00:00:00.000Z'),
      },
    ]);
    const targets = new ResolveUserTargetUseCase(users);

    const error = await targets.execute('@ALEX').catch((error: unknown) => {
      if (error instanceof AmbiguousUserTargetError) return error;
      throw error;
    });

    expect(error).toBeInstanceOf(AmbiguousUserTargetError);
    expect((error as AmbiguousUserTargetError).matches).toEqual([
      { telegramId: 1001, name: 'Alex' },
      { telegramId: 1002, name: 'alex' },
    ]);
  });
});
