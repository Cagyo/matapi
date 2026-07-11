import { Bot, InputFile } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotifierAdapter } from '../../../src/telegram/infrastructure/telegram-notifier.adapter';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { User } from '../../../src/telegram/domain/user.entity';

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

function makeUser(overrides: Partial<User> = {}): User {
  return {
    telegramId: 1001,
    name: 'Ada',
    role: 'admin',
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('TelegramNotifierAdapter', () => {
  let users: InMemoryUserRepository;
  let adapter: TelegramNotifierAdapter;

  function withUsers(seed: User[]): void {
    users = new InMemoryUserRepository(seed);
    adapter = new TelegramNotifierAdapter(users);
  }

  beforeEach(() => {
    withUsers([]);
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
    withUsers([
      makeUser({ telegramId: 1001, name: 'Ada', role: 'admin' }),
      makeUser({ telegramId: 1002, name: 'Linus', role: 'user' }),
    ]);
    adapter.setBot(bot);

    await adapter.notify({ text: 'front_door opened', asFile: false });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(1, 1001, 'front_door opened');
    expect(bot.api.sendMessage).toHaveBeenNthCalledWith(2, 1002, 'front_door opened');
    expect(bot.api.sendDocument).not.toHaveBeenCalled();
  });

  it('passes notification actions as an inline keyboard', async () => {
    const bot = makeBot();
    withUsers([makeUser()]);
    adapter.setBot(bot);

    await adapter.notify({
      text: 'critical alert',
      asFile: false,
      actions: [[{ text: '📋 View Logs', callbackData: 'logs:id:sensor-id' }]],
    });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(1001, 'critical alert', {
      reply_markup: {
        inline_keyboard: [[{ text: '📋 View Logs', callback_data: 'logs:id:sensor-id' }]],
      },
    });
  });

  it('sends file notifications as Telegram documents', async () => {
    const bot = makeBot();
    withUsers([makeUser()]);
    adapter.setBot(bot);

    await adapter.notify({ text: 'large offline summary', asFile: true });

    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(bot.api.sendDocument.mock.calls[0][0]).toBe(1001);
    expect(bot.api.sendDocument.mock.calls[0][1]).toBeInstanceOf(InputFile);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('continues sending when one recipient fails', async () => {
    const bot = makeBot();
    withUsers([
      makeUser({ telegramId: 1001 }),
      makeUser({ telegramId: 1002, name: 'Linus', role: 'user' }),
    ]);
    bot.api.sendMessage.mockRejectedValueOnce(new Error('blocked'));
    adapter.setBot(bot);

    await expect(
      adapter.notify({ text: 'front_door opened', asFile: false }),
    ).resolves.toBeUndefined();

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects when every recipient delivery fails', async () => {
    const bot = makeBot();
    withUsers([makeUser()]);
    bot.api.sendMessage.mockRejectedValue(new Error('telegram down'));
    adapter.setBot(bot);

    await expect(
      adapter.notify({ text: 'front_door opened', asFile: false }),
    ).rejects.toThrow('telegram down');
  });
});
