import { Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { ClaimAdminUseCase } from '../../../src/telegram/application/claim-admin.use-case';
import { AdminAlreadyClaimedError } from '../../../src/telegram/domain/errors/admin-already-claimed.error';
import { AdminClaimNotConfiguredError } from '../../../src/telegram/domain/errors/admin-claim-not-configured.error';
import { InvalidAdminClaimTokenError } from '../../../src/telegram/domain/errors/invalid-admin-claim-token.error';
import { ClaimAdminHandler } from '../../../src/telegram/interfaces/claim-admin.handler';

function createTestSetup() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const claimAdmin = { execute } as unknown as ClaimAdminUseCase;
  const updateUserMenu = vi.fn().mockResolvedValue(undefined);
  const botCommandsMenu = {
    updateUserMenu,
  } as unknown as BotCommandsMenuService;
  const handler = new ClaimAdminHandler(claimAdmin, botCommandsMenu);
  const commandCallbacks: Record<string, (ctx: Context) => Promise<void>> = {};
  const composer = {
    command: vi.fn((command: string, callback: (ctx: Context) => Promise<void>) => {
      commandCallbacks[command] = callback;
    }),
  } as unknown as Composer<Context>;

  handler.register(composer);

  return { commandCallbacks, execute, updateUserMenu };
}

function claimContext(match: string | undefined, reply = vi.fn().mockResolvedValue(undefined)) {
  return {
    from: { id: 123, first_name: 'Ada' },
    ...(match === undefined ? {} : { match }),
    reply,
  } as unknown as Context;
}

describe('ClaimAdminHandler', () => {
  it('passes the trimmed token to the use case and promotes the successful claimant menu', async () => {
    const { commandCallbacks, execute, updateUserMenu } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = claimContext('  owner-token  ', reply);

    await commandCallbacks.claim_admin(ctx);

    expect(execute).toHaveBeenCalledWith({
      telegramId: 123,
      name: 'Ada',
      token: 'owner-token',
    });
    expect(reply).toHaveBeenCalledWith(en.claim.success);
    expect(updateUserMenu).toHaveBeenCalledWith(123);
  });

  it.each([
    ['missing credential', undefined, ''],
    ['wrong credential', 'wrong-token', 'wrong-token'],
  ])('maps an invalid %s to the invalid-token response', async (_label, match, token) => {
    const { commandCallbacks, execute, updateUserMenu } = createTestSetup();
    execute.mockRejectedValue(new InvalidAdminClaimTokenError());
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = claimContext(match, reply);

    await commandCallbacks.claim_admin(ctx);

    expect(execute).toHaveBeenCalledWith({ telegramId: 123, name: 'Ada', token });
    expect(reply).toHaveBeenCalledWith(en.claim.invalidToken);
    expect(updateUserMenu).not.toHaveBeenCalled();
  });

  it('maps an unconfigured claim credential to the configuration response', async () => {
    const { commandCallbacks, execute, updateUserMenu } = createTestSetup();
    execute.mockRejectedValue(new AdminClaimNotConfiguredError());
    const reply = vi.fn().mockResolvedValue(undefined);

    await commandCallbacks.claim_admin(claimContext('owner-token', reply));

    expect(reply).toHaveBeenCalledWith(en.claim.notConfigured);
    expect(updateUserMenu).not.toHaveBeenCalled();
  });

  it('retains the already-claimed response', async () => {
    const { commandCallbacks, execute, updateUserMenu } = createTestSetup();
    execute.mockRejectedValue(new AdminAlreadyClaimedError());
    const reply = vi.fn().mockResolvedValue(undefined);

    await commandCallbacks.claim_admin(claimContext('owner-token', reply));

    expect(reply).toHaveBeenCalledWith(en.claim.alreadyClaimed);
    expect(updateUserMenu).not.toHaveBeenCalled();
  });

  it('keeps unexpected errors generic without logging the command argument', async () => {
    const { commandCallbacks, execute, updateUserMenu } = createTestSetup();
    const token = 'owner-token';
    execute.mockRejectedValue(new Error(`claim failed for ${token}`));
    const reply = vi.fn().mockResolvedValue(undefined);
    const loggerError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    let loggedText = '';

    try {
      await commandCallbacks.claim_admin(claimContext(token, reply));
      loggedText = loggerError.mock.calls.flat().join(' ');
    } finally {
      loggerError.mockRestore();
    }

    expect(reply).toHaveBeenCalledWith(en.common.error('claim admin', 'internal error'));
    expect(reply).not.toHaveBeenCalledWith(expect.stringContaining(token));
    expect(loggedText).not.toContain(token);
    expect(updateUserMenu).not.toHaveBeenCalled();
  });
});
