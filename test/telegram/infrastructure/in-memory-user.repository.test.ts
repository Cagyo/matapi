import { describe, expect, it } from 'vitest';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

describe('InMemoryUserRepository', () => {
  it('preserves an existing user locale when promoting them to admin', async () => {
    const repo = new InMemoryUserRepository();
    await repo.createUser({
      telegramId: 1001,
      name: 'Ada',
      role: 'user',
      locale: 'uk',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const promoted = await repo.createAdmin({
      telegramId: 1001,
      name: 'Ada Lovelace',
      role: 'admin',
      locale: 'en',
      createdAt: new Date('2030-01-02T00:00:00.000Z'),
    });

    expect(promoted).toMatchObject({
      name: 'Ada Lovelace',
      role: 'admin',
      locale: 'uk',
    });
  });
});
