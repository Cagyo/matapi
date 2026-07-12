import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';

function user(telegramId: number, role: 'admin' | 'user', locale: 'en' | 'ru' | 'uk') {
  return { telegramId, name: 'Alex', role, locale, muted: false, quietStart: null, quietEnd: null, createdAt: null };
}

afterEach(() => vi.useRealTimers());

describe('BotCommandsMenuService', () => {
  it('returns localized user commands and full localized admin commands', () => {
    const service = new BotCommandsMenuService({} as UserRepositoryPort);
    expect(service.getUserCommands('uk')).toEqual(catalogFor('uk').commands.filter((c) => c.scope === 'user').map(({ command, description }) => ({ command, description })));
    expect(service.getAdminCommands('ru')).toEqual(catalogFor('ru').commands.map(({ command, description }) => ({ command, description })));
  });

  it('loads the current user itself and applies their localized chat menu', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const users = { findByTelegramId: vi.fn().mockResolvedValue(user(100, 'admin', 'uk')) } as unknown as UserRepositoryPort;
    const service = new BotCommandsMenuService(users);
    service.setBot({ api: { setMyCommands } } as any);

    await service.updateUserMenu(100);

    expect(users.findByTelegramId).toHaveBeenCalledWith(100);
    expect(setMyCommands).toHaveBeenCalledWith(service.getAdminCommands('uk'), { scope: { type: 'chat', chat_id: 100 } });
  });

  it('serializes updates and derives the latest persisted locale for each job', async () => {
    let current = user(100, 'user', 'en');
    const users = {
      findByTelegramId: vi.fn(async () => current),
      setLocale: vi.fn(async (_telegramId: number, locale: 'en' | 'ru' | 'uk') => (current = user(100, 'user', locale))),
    } as unknown as UserRepositoryPort;
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const service = new BotCommandsMenuService(users);
    service.setBot({ api: { setMyCommands } } as any);

    await Promise.all([service.updateUserMenu(100), users.setLocale(100, 'uk').then(() => service.updateUserMenu(100))]);

    expect(setMyCommands).toHaveBeenLastCalledWith(service.getUserCommands('uk'), { scope: { type: 'chat', chat_id: 100 } });
  });

  it('retries failed Telegram updates after 1, 5, and 30 seconds before clearing the queue', async () => {
    vi.useFakeTimers();
    const setMyCommands = vi.fn().mockRejectedValue(new Error('Network error'));
    const users = { findByTelegramId: vi.fn().mockResolvedValue(user(100, 'user', 'en')) } as unknown as UserRepositoryPort;
    const service = new BotCommandsMenuService(users);
    service.setBot({ api: { setMyCommands } } as any);

    const update = service.updateUserMenu(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(setMyCommands).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setMyCommands).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setMyCommands).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(setMyCommands).toHaveBeenCalledTimes(4);
    await update;

    setMyCommands.mockResolvedValue(true);
    await service.updateUserMenu(100);
    expect(setMyCommands).toHaveBeenCalledTimes(5);
  });

  it('keeps English as the all-private-chats default and syncs every stored locale at startup', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const users = {
      listRecipients: vi.fn().mockResolvedValue([user(111, 'user', 'ru'), user(222, 'admin', 'uk')]),
      findByTelegramId: vi.fn(async (telegramId: number) => telegramId === 111 ? user(111, 'user', 'ru') : user(222, 'admin', 'uk')),
    } as unknown as UserRepositoryPort;
    const service = new BotCommandsMenuService(users);
    service.setBot({ api: { setMyCommands } } as any);

    await service.syncAllUsers();

    expect(setMyCommands).toHaveBeenCalledWith(service.getUserCommands('en'), { scope: { type: 'all_private_chats' } });
    expect(setMyCommands).toHaveBeenCalledWith(service.getUserCommands('ru'), { scope: { type: 'chat', chat_id: 111 } });
    expect(setMyCommands).toHaveBeenCalledWith(service.getAdminCommands('uk'), { scope: { type: 'chat', chat_id: 222 } });
  });
});
