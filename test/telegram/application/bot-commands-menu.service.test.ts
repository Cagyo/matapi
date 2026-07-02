import { describe, expect, it, vi } from 'vitest';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';

describe('BotCommandsMenuService', () => {
  it('returns filtered user commands and full admin commands', () => {
    const service = new BotCommandsMenuService({} as UserRepositoryPort);

    const userCmds = service.getUserCommands();
    const adminCmds = service.getAdminCommands();

    expect(userCmds.length).toBeGreaterThan(0);
    expect(adminCmds.length).toBeGreaterThan(userCmds.length);

    expect(userCmds.some((c) => c.command === 'menu')).toBe(true);
    expect(userCmds.some((c) => c.command === 'promote')).toBe(false);
    expect(adminCmds.some((c) => c.command === 'promote')).toBe(true);
  });

  it('updateUserMenu does nothing when bot is not set', async () => {
    const service = new BotCommandsMenuService({} as UserRepositoryPort);
    await expect(service.updateUserMenu(12345, 'user')).resolves.toBeUndefined();
  });

  it('updateUserMenu sets chat scope commands for user and admin', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const mockBot = { api: { setMyCommands } } as any;

    const service = new BotCommandsMenuService({} as UserRepositoryPort);
    service.setBot(mockBot);

    await service.updateUserMenu(100, 'user');
    expect(setMyCommands).toHaveBeenCalledWith(
      service.getUserCommands(),
      { scope: { type: 'chat', chat_id: 100 } },
    );

    await service.updateUserMenu(200, 'admin');
    expect(setMyCommands).toHaveBeenCalledWith(
      service.getAdminCommands(),
      { scope: { type: 'chat', chat_id: 200 } },
    );
  });

  it('updateUserMenu logs and suppresses errors from Telegram API', async () => {
    const setMyCommands = vi.fn().mockRejectedValue(new Error('Network error'));
    const mockBot = { api: { setMyCommands } } as any;

    const service = new BotCommandsMenuService({} as UserRepositoryPort);
    service.setBot(mockBot);

    await expect(service.updateUserMenu(100, 'user')).resolves.toBeUndefined();
  });

  it('syncAllUsers sets default commands and updates all registered users', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const mockBot = { api: { setMyCommands } } as any;

    const users: UserRepositoryPort = {
      listRecipients: vi.fn().mockResolvedValue([
        { telegramId: 111, role: 'user' },
        { telegramId: 222, role: 'admin' },
      ]),
    } as any;

    const service = new BotCommandsMenuService(users);
    service.setBot(mockBot);

    await service.syncAllUsers();

    expect(setMyCommands).toHaveBeenCalledWith(service.getUserCommands(), {
      scope: { type: 'all_private_chats' },
    });
    expect(setMyCommands).toHaveBeenCalledWith(service.getUserCommands(), {
      scope: { type: 'chat', chat_id: 111 },
    });
    expect(setMyCommands).toHaveBeenCalledWith(service.getAdminCommands(), {
      scope: { type: 'chat', chat_id: 222 },
    });
  });

  it('syncAllUsers suppresses errors from listRecipients or Telegram API', async () => {
    const setMyCommands = vi.fn().mockRejectedValue(new Error('API fail'));
    const mockBot = { api: { setMyCommands } } as any;

    const users: UserRepositoryPort = {
      listRecipients: vi.fn().mockRejectedValue(new Error('DB fail')),
    } as any;

    const service = new BotCommandsMenuService(users);
    service.setBot(mockBot);

    await expect(service.syncAllUsers()).resolves.toBeUndefined();
  });
});
