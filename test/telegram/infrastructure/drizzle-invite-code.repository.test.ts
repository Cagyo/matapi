import { describe, expect, it } from 'vitest';
import { DrizzleInviteCodeRepository } from '../../../src/telegram/infrastructure/drizzle-invite-code.repository';
import { DrizzleUserRepository } from '../../../src/telegram/infrastructure/drizzle-user.repository';
import { createTestDatabase } from '../../helpers/database';

// `invite_codes.created_by` has a FK to `users.telegram_id` (enforced in the
// test DB), so the creating admin must exist before a code can be inserted.
async function seedCreatorAdmin(ctx: ReturnType<typeof createTestDatabase>) {
  await new DrizzleUserRepository(ctx.appDb).createAdmin({
    telegramId: 1,
    name: 'Admin',
    role: 'admin',
    createdAt: new Date(),
  });
}

describe('DrizzleInviteCodeRepository', () => {
  it('creates and finds a code', async () => {
    const ctx = createTestDatabase();
    const repo = new DrizzleInviteCodeRepository(ctx.appDb);
    await seedCreatorAdmin(ctx);
    await repo.create({ code: 'ABC', role: 'user', createdBy: 1, createdAt: new Date() });
    expect((await repo.findByCode('ABC'))?.role).toBe('user');
    ctx.close();
  });

  it('redeems an unused code exactly once', async () => {
    const ctx = createTestDatabase();
    const repo = new DrizzleInviteCodeRepository(ctx.appDb);
    await seedCreatorAdmin(ctx);
    await repo.create({ code: 'ABC', role: 'user', createdBy: 1, createdAt: new Date() });

    const first = await repo.redeem('ABC', 42, new Date('2030-01-01T00:00:00Z'));
    const second = await repo.redeem('ABC', 99, new Date('2030-01-02T00:00:00Z'));

    expect(first?.usedBy).toBe(42);
    expect(second).toBeNull();
    expect((await repo.findByCode('ABC'))?.usedBy).toBe(42);
    ctx.close();
  });

  it('returns null for an unknown code', async () => {
    const ctx = createTestDatabase();
    const repo = new DrizzleInviteCodeRepository(ctx.appDb);
    expect(await repo.redeem('NOPE', 1, new Date())).toBeNull();
    ctx.close();
  });
});
