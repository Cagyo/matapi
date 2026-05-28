import { Bot, InputFile } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '../../../src/database/schema';
import { TelegramNotifierAdapter } from '../../../src/telegram/infrastructure/telegram-notifier.adapter';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

type FakeBot = Bot & {
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
  };
};

function makeBot(): FakeBot {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as FakeBot;
}

describe('TelegramNotifierAdapter', () => {
  let context: TestDatabaseContext;
  let adapter: TelegramNotifierAdapter;

  beforeEach(() => {
    context = createTestDatabase();
    adapter = new TelegramNotifierAdapter(context.appDb);
  });

  afterEach(() => {
    context.close();
  });

  it('reports readiness from the bot binding', () => {
    const bot = makeBot();

    expect(adapter.isReady()).toBe(false);
    adapter.setBot(bot);
    expect(adapter.isReady()).toBe(true);
    adapter.clearBot();
    expect(adapter.isReady()).toBe(false);
  });

  it('rejects notifications before a bot is registered', async () => {
    await expect(
      adapter.notify({ text: 'hello', asFile: false }),
    ).rejects.toThrow('Telegram bot is not ready');
  });

  it('sends text notifications to every registered user', async () => {
    const bot = makeBot();
    context.db
      .insert(users)
      .values([
        { telegramId: 1001, name: 'Ada', role: 'admin' },
        { telegramId: 1002, name: 'Linus', role: 'user' },
      ])
      .run();
    adapter.setBot(bot);

    await adapter.notify({ text: 'front_door opened', asFile: false });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(1, 1001, 'front_door opened');
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(2, 1002, 'front_door opened');
    expect(bot.api.sendDocument).not.toHaveBeenCalled();
  });

  it('sends file notifications as Telegram documents', async () => {
    const bot = makeBot();
    context.db.insert(users).values({ telegramId: 1001, name: 'Ada', role: 'admin' }).run();
    adapter.setBot(bot);

    await adapter.notify({ text: 'large offline summary', asFile: true });

    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(bot.api.sendDocument.mock.calls[0][0]).toBe(1001);
    expect(bot.api.sendDocument.mock.calls[0][1]).toBeInstanceOf(InputFile);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('continues sending when one recipient fails', async () => {
    const bot = makeBot();
    context.db
      .insert(users)
      .values([
        { telegramId: 1001, name: 'Ada', role: 'admin' },
        { telegramId: 1002, name: 'Linus', role: 'user' },
      ])
      .run();
    bot.api.sendMessage.mockRejectedValueOnce(new Error('blocked'));
    adapter.setBot(bot);

    await expect(
      adapter.notify({ text: 'front_door opened', asFile: false }),
    ).resolves.toBeUndefined();

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects when every recipient delivery fails', async () => {
    const bot = makeBot();
    context.db.insert(users).values({ telegramId: 1001, name: 'Ada', role: 'admin' }).run();
    bot.api.sendMessage.mockRejectedValue(new Error('telegram down'));
    adapter.setBot(bot);

    await expect(
      adapter.notify({ text: 'front_door opened', asFile: false }),
    ).rejects.toThrow('telegram down');
  });
});