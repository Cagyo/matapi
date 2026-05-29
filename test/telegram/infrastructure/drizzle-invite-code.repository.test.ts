import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleInviteCodeRepository } from '../../../src/telegram/infrastructure/drizzle-invite-code.repository';
import { DrizzleUserRepository } from '../../../src/telegram/infrastructure/drizzle-user.repository';
import { InvalidInviteCodeError } from '../../../src/telegram/domain/errors/invalid-invite-code.error';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleInviteCodeRepository', () => {
  let ctx: TestDatabaseContext;
  let repo: DrizzleInviteCodeRepository;
  let users: DrizzleUserRepository;

  beforeEach(async () => {
    ctx = createTestDatabase();
    repo = new DrizzleInviteCodeRepository(ctx.appDb);
    users = new DrizzleUserRepository(ctx.appDb);
    await users.createAdmin({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  afterEach(() => ctx.close());

  it('creates, looks up, and marks codes used', async () => {
    const created = await repo.create({
      code: 'ABCDEFGH',
      role: 'user',
      createdBy: 1001,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(created.usedBy).toBeNull();

    const found = await repo.findByCode('ABCDEFGH');
    expect(found?.createdBy).toBe(1001);

    const used = await repo.markUsed(
      'ABCDEFGH',
      2002,
      new Date('2030-02-02T00:00:00.000Z'),
    );
    expect(used.usedBy).toBe(2002);
    expect(used.usedAt).toEqual(new Date('2030-02-02T00:00:00.000Z'));
  });

  it('returns null for unknown codes and throws when marking unknown', async () => {
    expect(await repo.findByCode('NOPE')).toBeNull();
    await expect(
      repo.markUsed('NOPE', 1, new Date()),
    ).rejects.toBeInstanceOf(InvalidInviteCodeError);
  });
});
