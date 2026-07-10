import { Composer, Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { DemoteUserUseCase } from '../../../src/telegram/application/demote-user.use-case';
import { LastAdminDemotionError } from '../../../src/telegram/domain/errors/last-admin-demotion.error';
import { DirectMessengerPort } from '../../../src/telegram/domain/ports/direct-messenger.port';
import { DemoteHandler } from '../../../src/telegram/interfaces/demote.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

describe('DemoteHandler', () => {
  it('maps final-admin demotion to its dedicated response', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new LastAdminDemotionError());
    const demote = { execute } as unknown as DemoteUserUseCase;
    const guard = { adminOnly: vi.fn() } as unknown as RoleMiddleware;
    const dm = { send: vi.fn() } as unknown as DirectMessengerPort;
    const menu = {
      updateUserMenu: vi.fn(),
    } as unknown as BotCommandsMenuService;
    const handler = new DemoteHandler(demote, guard, dm, menu);
    const commandCallbacks: Record<string, (ctx: Context) => Promise<void>> =
      {};
    const composer = {
      command: vi.fn(
        (
          command: string,
          _middleware: unknown,
          callback: (ctx: Context) => Promise<void>,
        ) => {
          commandCallbacks[command] = callback;
        },
      ),
    } as unknown as Composer<Context>;
    const reply = vi.fn().mockResolvedValue(undefined);

    handler.register(composer);
    await commandCallbacks.demote({
      from: { id: 123, first_name: 'Ada' },
      match: 'Ada',
      reply,
    } as unknown as Context);

    expect(reply).toHaveBeenCalledWith(en.users.finalAdmin);
  });
});
