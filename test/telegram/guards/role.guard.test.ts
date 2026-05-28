import { Context, NextFunction } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../../src/database/schema';
import { en } from '../../../src/locales/en';
import { RoleGuard } from '../../../src/telegram/guards/role.guard';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

function makeContext(id?: number): Context & { reply: ReturnType<typeof vi.fn> } {
  return {
    from: id === undefined ? undefined : { id },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context & { reply: ReturnType<typeof vi.fn> };
}

describe('RoleGuard', () => {
  let context: TestDatabaseContext;
  let guard: RoleGuard;
  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    context = createTestDatabase();
    guard = new RoleGuard(context.appDb);
    next = vi.fn().mockResolvedValue(undefined) as NextFunction & ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    context.close();
  });

  it('allows registered users through', async () => {
    context.db.insert(users).values({ telegramId: 1001, name: 'Ada', role: 'user' }).run();
    const ctx = makeContext(1001);

    await guard.registered(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('silently ignores unregistered users', async () => {
    const ctx = makeContext(1001);

    await guard.registered(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('allows admins through admin-only middleware', async () => {
    context.db.insert(users).values({ telegramId: 1001, name: 'Ada', role: 'admin' }).run();
    const ctx = makeContext(1001);

    await guard.adminOnly(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('replies and stops when a non-admin reaches admin-only middleware', async () => {
    context.db.insert(users).values({ telegramId: 1001, name: 'Ada', role: 'user' }).run();
    const ctx = makeContext(1001);

    await guard.adminOnly(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith(en.common.adminRequired);
    expect(next).not.toHaveBeenCalled();
  });
});