import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleUserRepository } from '../../../src/telegram/infrastructure/drizzle-user.repository';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleUserRepository', () => {
  let context: TestDatabaseContext;
  let repo: DrizzleUserRepository;

  beforeEach(() => {
    context = createTestDatabase();
    repo = new DrizzleUserRepository(context.appDb);
  });

  afterEach(() => context.close());

  it('counts admins and returns null for unknown telegram ids', async () => {
    expect(await repo.countAdmins()).toBe(0);
    expect(await repo.findByTelegramId(404)).toBeNull();
  });

  it('persists a new admin via createAdmin and lists them', async () => {
    const created = await repo.createAdmin({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(created).toMatchObject({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
    });
    expect(await repo.countAdmins()).toBe(1);
    expect(await repo.findByTelegramId(1001)).toMatchObject({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
    });
    expect(await repo.listRecipients()).toHaveLength(1);
  });

  it('upgrades an existing user to admin via onConflict', async () => {
    await repo.createAdmin({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const upserted = await repo.createAdmin({
      telegramId: 1001,
      name: 'Ada Lovelace',
      role: 'admin',
      createdAt: new Date('2030-01-02T00:00:00.000Z'),
    });

    expect(upserted.name).toBe('Ada Lovelace');
    expect(await repo.countAdmins()).toBe(1);
  });

  it('creates a regular user via createUser and finds by case-insensitive name', async () => {
    await repo.createUser({
      telegramId: 2002,
      name: 'Alex',
      role: 'user',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(await repo.findByName('alex')).toMatchObject({ telegramId: 2002 });
    expect(await repo.findByName('@ALEX')).toMatchObject({ telegramId: 2002 });
    expect(await repo.findByName('ghost')).toBeNull();
  });

  it('updates role via updateRole', async () => {
    await repo.createUser({
      telegramId: 2002,
      name: 'Alex',
      role: 'user',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const updated = await repo.updateRole(2002, 'admin');
    expect(updated.role).toBe('admin');
    expect(await repo.countAdmins()).toBe(1);
  });

  it('claimFirstAdmin creates once, then returns null', async () => {
    const ctx = createTestDatabase();
    const repo = new DrizzleUserRepository(ctx.appDb);

    const first = await repo.claimFirstAdmin({
      telegramId: 1,
      name: 'A',
      role: 'admin',
      createdAt: new Date(),
    });
    const second = await repo.claimFirstAdmin({
      telegramId: 2,
      name: 'B',
      role: 'admin',
      createdAt: new Date(),
    });

    expect(first?.role).toBe('admin');
    expect(second).toBeNull();
    expect(await repo.countAdmins()).toBe(1);
    ctx.close();
  });
});
