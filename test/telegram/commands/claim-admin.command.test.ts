import { eq } from 'drizzle-orm';
import { Bot, Context } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../../src/database/schema';
import { en } from '../../../src/locales/en';
import { ClaimAdminCommand } from '../../../src/telegram/commands/claim-admin.command';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

function makeBot() {
  return { command: vi.fn() } as unknown as Bot & {
    command: ReturnType<typeof vi.fn>;
  };
}

function makeContext(id: number, name = 'Ada'): Context & { reply: ReturnType<typeof vi.fn> } {
  return {
    from: { id, first_name: name },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context & { reply: ReturnType<typeof vi.fn> };
}

describe('ClaimAdminCommand', () => {
  let context: TestDatabaseContext;

  beforeEach(() => {
    context = createTestDatabase();
  });

  afterEach(() => {
    context.close();
  });

  it('lets the first Telegram user claim admin', async () => {
    const bot = makeBot();
    const command = new ClaimAdminCommand(context.appDb);
    command.register(bot);
    const handler = bot.command.mock.calls[0][1] as (ctx: Context) => Promise<void>;
    const ctx = makeContext(1001);

    await handler(ctx);

    const admin = context.db.select().from(users).where(eq(users.telegramId, 1001)).get();
    expect(ctx.reply).toHaveBeenCalledWith(en.claim.success);
    expect(admin).toMatchObject({ telegramId: 1001, name: 'Ada', role: 'admin' });
    expect(command.hasAdmin()).toBe(true);
    expect(command.getAdmins()).toEqual([1001]);
  });

  it('keeps claim disabled after any user exists', async () => {
    context.db.insert(users).values({ telegramId: 1001, name: 'Ada', role: 'admin' }).run();
    const bot = makeBot();
    const command = new ClaimAdminCommand(context.appDb);
    command.register(bot);
    const handler = bot.command.mock.calls[0][1] as (ctx: Context) => Promise<void>;
    const ctx = makeContext(1002, 'Grace');

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(en.claim.alreadyClaimed);
    expect(command.getAdmins()).toEqual([1001]);
    expect(context.db.select().from(users).where(eq(users.telegramId, 1002)).get()).toBeUndefined();
  });

  it('ignores claim requests without Telegram sender data', async () => {
    const bot = makeBot();
    const command = new ClaimAdminCommand(context.appDb);
    command.register(bot);
    const handler = bot.command.mock.calls[0][1] as (ctx: Context) => Promise<void>;
    const reply = vi.fn();

    await handler({ reply } as unknown as Context);

    expect(reply).not.toHaveBeenCalled();
    expect(command.hasAdmin()).toBe(false);
  });
});