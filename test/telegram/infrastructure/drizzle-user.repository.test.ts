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
      locale: 'en',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(created).toMatchObject({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      locale: 'en',
    });
    expect(await repo.countAdmins()).toBe(1);
    expect(await repo.findByTelegramId(1001)).toMatchObject({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      locale: 'en',
    });
    expect(await repo.listRecipients()).toHaveLength(1);
  });

  it('upgrades an existing user to admin via onConflict', async () => {
    await repo.createUser({
      telegramId: 1001,
      name: 'Ada',
      role: 'user',
      locale: 'uk',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const upserted = await repo.createAdmin({
      telegramId: 1001,
      name: 'Ada Lovelace',
      role: 'admin',
      locale: 'en',
      createdAt: new Date('2030-01-02T00:00:00.000Z'),
    });

    expect(upserted.name).toBe('Ada Lovelace');
    expect(upserted.role).toBe('admin');
    expect(upserted.locale).toBe('uk');
    expect(await repo.countAdmins()).toBe(1);
  });

  it('finds all case-insensitive name matches after stripping a leading @', async () => {
    await repo.createUser({
      telegramId: 2002,
      name: 'Alex',
      role: 'user',
      locale: 'en',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    await repo.createUser({
      telegramId: 2003,
      name: 'alex',
      role: 'user',
      locale: 'en',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(await repo.findByName('@ALEX')).toMatchObject([
      { telegramId: 2002 },
      { telegramId: 2003 },
    ]);
    expect(await repo.findByName('ghost')).toEqual([]);
  });

  it('updates role via updateRole', async () => {
    await repo.createUser({
      telegramId: 2002,
      name: 'Alex',
      role: 'user',
      locale: 'en',
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
      locale: 'en',
      createdAt: new Date(),
    });
    const second = await repo.claimFirstAdmin({
      telegramId: 2,
      name: 'B',
      role: 'admin',
      locale: 'en',
      createdAt: new Date(),
    });

    expect(first).toMatchObject({ role: 'admin', locale: 'en' });
    expect(second).toBeNull();
    expect(await repo.countAdmins()).toBe(1);
    ctx.close();
  });

  it('keeps the final admin when demoting atomically', async () => {
    await repo.createAdmin({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      locale: 'en',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    await expect(repo.demoteAdminIfNotLast(1001)).resolves.toBeNull();
    expect(await repo.countAdmins()).toBe(1);
  });

  it('persists user locale and updates only the targeted user locale', async () => {
    const first = await repo.createUser({
      telegramId: 2001,
      name: 'Ada',
      role: 'user',
      locale: 'en',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    await repo.createUser({
      telegramId: 2002,
      name: 'Linus',
      role: 'user',
      locale: 'en',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const updated = await repo.setLocale(2001, 'uk');

    expect(first.locale).toBe('en');
    expect(updated.locale).toBe('uk');
    expect((await repo.findByTelegramId(2002))?.locale).toBe('en');
  });
});
