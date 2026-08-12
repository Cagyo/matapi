import { Composer, Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { DemoteUserUseCase } from '../../../src/telegram/application/demote-user.use-case';
import { AmbiguousUserTargetError } from '../../../src/telegram/domain/errors/ambiguous-user-target.error';
import { LastAdminDemotionError } from '../../../src/telegram/domain/errors/last-admin-demotion.error';
import { UserNotFoundError } from '../../../src/telegram/domain/errors/user-not-found.error';
import { DirectMessengerPort } from '../../../src/telegram/domain/ports/direct-messenger.port';
import { DemoteHandler } from '../../../src/telegram/interfaces/demote.handler';
import { DriveSetupStateRegistry } from '../../../src/telegram/interfaces/drive-setup-state.registry';
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
    const setupStates = { cancelUser: vi.fn() } as unknown as DriveSetupStateRegistry;
    const handler = new DemoteHandler(demote, guard, dm, menu, setupStates);
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

  it('maps ambiguous targets without notifying or changing the target menu', async () => {
    const matches = [
      { telegramId: 1001, name: 'Alex' },
      { telegramId: 1002, name: 'alex' },
    ];
    const execute = vi
      .fn()
      .mockRejectedValue(new AmbiguousUserTargetError('@ALEX', matches));
    const demote = { execute } as unknown as DemoteUserUseCase;
    const guard = { adminOnly: vi.fn() } as unknown as RoleMiddleware;
    const dm = { send: vi.fn() } as unknown as DirectMessengerPort;
    const menu = {
      updateUserMenu: vi.fn(),
    } as unknown as BotCommandsMenuService;
    const setupStates = { cancelUser: vi.fn() } as unknown as DriveSetupStateRegistry;
    const handler = new DemoteHandler(demote, guard, dm, menu, setupStates);
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
      match: '@ALEX',
      reply,
    } as unknown as Context);

    expect(reply).toHaveBeenCalledWith(
      en.users.ambiguousTarget('demote', matches),
    );
    expect(dm.send).not.toHaveBeenCalled();
    expect(menu.updateUserMenu).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'authorizing'] as const)('cancels %s Drive setup only after demotion commits', async (state) => {
    const demoted = { telegramId: 7, name: 'Ada' };
    const demote = { execute: vi.fn().mockResolvedValue(demoted) };
    const guard = { adminOnly: vi.fn() };
    const dm = { send: vi.fn().mockResolvedValue(undefined) };
    const menu = { updateUserMenu: vi.fn().mockResolvedValue(undefined) };
    const cancelConnection = { execute: vi.fn().mockResolvedValue('cancelled') };
    const setupStates = new DriveSetupStateRegistry(
      { now: () => new Date(1_000) }, cancelConnection as never, { register: vi.fn() } as never,
    );
    const identity = { userId: 7, chatId: 9, receiptId: 'abcdefghijklmnop' };
    setupStates.prepare({ ...identity, preparationExpiresAtMs: 20_000 });
    if (state === 'authorizing') {
      setupStates.claimAuthorizing(identity, {
        generationId: 'generation-00001', receiptId: identity.receiptId,
        adminUserId: identity.userId, chatId: identity.chatId,
        installationId: 'installation-1', createdAtMs: 1_000, expiresAtMs: 11_000,
      });
    }
    const cancelUser = vi.spyOn(setupStates, 'cancelUser');
    const handler = new DemoteHandler(
      demote as never, guard as never, dm, menu as never, setupStates,
    );
    const commandCallbacks: Record<string, (ctx: Context) => Promise<void>> = {};
    const composer = {
      command: vi.fn((command: string, _middleware: unknown, callback: (ctx: Context) => Promise<void>) => {
        commandCallbacks[command] = callback;
      }),
    } as unknown as Composer<Context>;
    const reply = vi.fn().mockResolvedValue(undefined);
    handler.register(composer);

    await commandCallbacks.demote({
      from: { id: 123, first_name: 'Admin' }, match: '@Ada', reply,
    } as unknown as Context);

    expect(cancelUser).toHaveBeenCalledWith(7);
    expect(demote.execute.mock.invocationCallOrder[0])
      .toBeLessThan(cancelUser.mock.invocationCallOrder[0]);
    expect(setupStates.association({ userId: 7, chatId: 9 })).toBeNull();
    expect(cancelConnection.execute).toHaveBeenCalledTimes(state === 'authorizing' ? 1 : 0);
  });

  it('does not cancel Drive setup when demotion is rejected', async () => {
    const demote = { execute: vi.fn().mockRejectedValue(new UserNotFoundError()) };
    const setupStates = { cancelUser: vi.fn() };
    const { callback, reply } = registeredDemote(demote, setupStates);

    await callback('@missing');

    expect(setupStates.cancelUser).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(en.users.userNotFound);
  });

  it('keeps the committed demotion authoritative when Drive cleanup fails', async () => {
    const demoted = { telegramId: 7, name: 'Ada' };
    const demote = { execute: vi.fn().mockResolvedValue(demoted) };
    const setupStates = { cancelUser: vi.fn().mockRejectedValue(new Error('repository unavailable')) };
    const { callback, reply, dm, menu } = registeredDemote(demote, setupStates);

    await callback('@Ada');

    expect(reply).toHaveBeenCalledWith(en.users.demoted('Ada'));
    expect(menu.updateUserMenu).toHaveBeenCalledWith(7);
    expect(dm.send).toHaveBeenCalledWith(7, en.users.demotedNotice('Admin'));
    expect(demote.execute).toHaveBeenCalledOnce();
  });
});

function registeredDemote(
  demote: { execute: ReturnType<typeof vi.fn> },
  setupStates: { cancelUser: ReturnType<typeof vi.fn> },
) {
  const guard = { adminOnly: vi.fn() };
  const dm = { send: vi.fn().mockResolvedValue(undefined) };
  const menu = { updateUserMenu: vi.fn().mockResolvedValue(undefined) };
  const handler = new DemoteHandler(
    demote as never, guard as never, dm, menu as never, setupStates as never,
  );
  const commandCallbacks: Record<string, (ctx: Context) => Promise<void>> = {};
  const composer = {
    command: vi.fn((command: string, _middleware: unknown, callback: (ctx: Context) => Promise<void>) => {
      commandCallbacks[command] = callback;
    }),
  } as unknown as Composer<Context>;
  const reply = vi.fn().mockResolvedValue(undefined);
  handler.register(composer);

  return {
    callback: (target: string) => commandCallbacks.demote({
      from: { id: 123, first_name: 'Admin' }, match: target, reply,
    } as unknown as Context),
    reply,
    dm,
    menu,
  };
}
