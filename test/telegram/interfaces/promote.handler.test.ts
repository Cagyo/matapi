import { Composer, Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { PromoteUserUseCase } from '../../../src/telegram/application/promote-user.use-case';
import { AmbiguousUserTargetError } from '../../../src/telegram/domain/errors/ambiguous-user-target.error';
import { DirectMessengerPort } from '../../../src/telegram/domain/ports/direct-messenger.port';
import { PromoteHandler } from '../../../src/telegram/interfaces/promote.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

describe('PromoteHandler', () => {
  it('maps ambiguous targets without notifying or changing the target menu', async () => {
    const matches = [
      { telegramId: 1001, name: 'Alex' },
      { telegramId: 1002, name: 'alex' },
    ];
    const execute = vi
      .fn()
      .mockRejectedValue(new AmbiguousUserTargetError('@ALEX', matches));
    const promote = { execute } as unknown as PromoteUserUseCase;
    const guard = { adminOnly: vi.fn() } as unknown as RoleMiddleware;
    const dm = { send: vi.fn() } as unknown as DirectMessengerPort;
    const menu = {
      updateUserMenu: vi.fn(),
    } as unknown as BotCommandsMenuService;
    const handler = new PromoteHandler(promote, guard, dm, menu);
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
    await commandCallbacks.promote({
      from: { id: 123, first_name: 'Ada' },
      match: '@ALEX',
      reply,
    } as unknown as Context);

    expect(reply).toHaveBeenCalledWith(
      en.users.ambiguousTarget('promote', matches),
    );
    expect(dm.send).not.toHaveBeenCalled();
    expect(menu.updateUserMenu).not.toHaveBeenCalled();
  });
});
