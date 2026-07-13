import { sequentialize } from '@grammyjs/runner';
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { homeUpdateConstraints } from '../../../src/telegram/interfaces/home-update-constraints';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function context(chatId?: number, userId?: number, chatType: 'private' | 'group' = 'private'): TelegramContext {
  return {
    chat: chatId === undefined ? undefined : { id: chatId, type: chatType },
    from: userId === undefined ? undefined : { id: userId },
  } as TelegramContext;
}

function update(updateId: number, chatId: number, userId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Home' },
      text: 'home',
    },
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

describe('homeUpdateConstraints', () => {
  it('returns chat and user constraints for a complete private update', () => {
    expect(homeUpdateConstraints(context(123, 456))).toEqual(['home:chat:123', 'home:user:456']);
  });

  it.each([
    [context(123, undefined)],
    [context(undefined, 456)],
    [context(123, 456, 'group')],
  ])('returns no constraints when the update is not a complete private update', (ctx) => {
    expect(homeUpdateConstraints(ctx)).toEqual([]);
  });

  it('serializes matching pairs while allowing different pairs to overlap', async () => {
    const bot = new Bot<TelegramContext>('123456:token', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'Home',
        username: 'home_test_bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    });
    const entered: number[] = [];
    const releases = new Map<number, () => void>();

    bot.use(sequentialize(homeUpdateConstraints));
    bot.use(async (ctx) => {
      const updateId = ctx.update.update_id;
      entered.push(updateId);
      await new Promise<void>((resolve) => releases.set(updateId, resolve));
    });

    const first = bot.handleUpdate(update(1, 10, 20));
    await waitFor(() => expect(entered).toEqual([1]));
    const samePair = bot.handleUpdate(update(2, 10, 20));
    const differentPair = bot.handleUpdate(update(3, 11, 21));
    await waitFor(() => expect(entered).toContain(3));

    expect(entered).not.toContain(2);
    releases.get(1)!();
    await waitFor(() => expect(entered).toContain(2));
    releases.get(2)!();
    releases.get(3)!();
    await Promise.all([first, samePair, differentPair]);
  });
});
