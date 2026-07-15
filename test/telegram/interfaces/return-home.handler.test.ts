import { Composer } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { ConfigHandler } from '../../../src/telegram/interfaces/config.handler';
import { GdriveAuthHandler } from '../../../src/telegram/interfaces/gdrive-auth.handler';
import { HomeLauncher } from '../../../src/telegram/interfaces/home-launcher';
import { ImportConfigHandler } from '../../../src/telegram/interfaces/import-config.handler';
import { ReturnHomeHandler } from '../../../src/telegram/interfaces/return-home.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { SystemUpdateHandler } from '../../../src/telegram/interfaces/system-update.handler';
import { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function callbackContext(
  data: string,
  extra: Partial<TelegramContext> = {},
): TelegramContext {
  return {
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    ...extra,
  } as unknown as TelegramContext;
}

function setup() {
  const launcher = { launch: vi.fn().mockResolvedValue('opened') } as unknown as HomeLauncher;
  const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
  const cancelers = {
    config: { cancelPending: vi.fn() },
    configImport: { cancelPending: vi.fn() },
    drive: { cancelPending: vi.fn() },
    systemUpdate: { cancelPending: vi.fn() },
  };
  const handler = new ReturnHomeHandler(
    launcher,
    guard,
    cancelers.config as unknown as ConfigHandler,
    cancelers.configImport as unknown as ImportConfigHandler,
    cancelers.drive as unknown as GdriveAuthHandler,
    cancelers.systemUpdate as unknown as SystemUpdateHandler,
  );
  let capturedRegex!: RegExp;
  let callback!: (ctx: TelegramContext) => Promise<void>;
  const composer = {
    callbackQuery: vi.fn((regex: RegExp, _middleware: unknown, fn: typeof callback) => {
      capturedRegex = regex;
      callback = fn;
    }),
  } as unknown as Composer<TelegramContext>;

  handler.register(composer);

  return { launcher, guard, composer, capturedRegex, callback, cancelers };
}

describe('ReturnHomeHandler', () => {
  it('registers exact return payloads behind the registered-user guard', () => {
    const { composer, guard, capturedRegex } = setup();

    expect(composer.callbackQuery).toHaveBeenCalledWith(
      expect.any(RegExp),
      guard.registered,
      expect.any(Function),
    );
    expect(capturedRegex.test('rh:c:t')).toBe(true);
    expect(capturedRegex.test('rh:c:x')).toBe(false);
    expect(capturedRegex.test('rh:f:c\n')).toBe(false);
    expect(capturedRegex.test('rh:f:c\r')).toBe(false);
    expect(capturedRegex.test('rh:f:c\u2028')).toBe(false);
    expect(capturedRegex.test('rh:f:c\u2029')).toBe(false);
    expect(capturedRegex.test('rh:f:c\r\n')).toBe(false);
    expect(capturedRegex.source).toBe('^rh:[lcsfidu]:[crt](?![\\s\\S])');
  });

  it('does not acknowledge twice and delegates a valid return', async () => {
    const { callback, launcher } = setup();
    const ctx = callbackContext('rh:l:c', { homeCallbackAcknowledged: true });

    await callback(ctx);

    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalledWith(ctx);
  });

  it('acknowledges best-effort before launching when upstream middleware did not', async () => {
    const { callback, launcher } = setup();
    const ctx = callbackContext('rh:s:r', {
      answerCallbackQuery: vi.fn().mockRejectedValue(new Error('expired')),
    });

    await callback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(launcher.launch).toHaveBeenCalledWith(ctx);
  });

  it('treats simultaneous return clicks as independent fresh-open attempts', async () => {
    const { callback, launcher } = setup();

    await Promise.all([
      callback(callbackContext('rh:s:c')),
      callback(callbackContext('rh:s:c')),
    ]);

    expect(launcher.launch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['rh:f:c', 'config'],
    ['rh:i:c', 'configImport'],
    ['rh:d:c', 'drive'],
    ['rh:u:c', 'systemUpdate'],
  ] as const)('cancels %s before opening Home', async (data, target) => {
    const { callback, cancelers, launcher } = setup();
    const order: string[] = [];
    cancelers[target].cancelPending.mockImplementation(() => order.push('cancel'));
    (launcher.launch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('launch');
      return 'opened';
    });

    await callback(callbackContext(data, {
      from: { id: 42 },
      homeCallbackAcknowledged: true,
    }));

    expect(cancelers[target].cancelPending).toHaveBeenCalledWith(42);
    expect(order).toEqual(['cancel', 'launch']);
  });

  it.each(['rh:f:t', 'rh:i:t', 'rh:d:t', 'rh:u:r'])(
    'does not cancel a terminal or running return %s',
    async (data) => {
      const { callback, cancelers, launcher } = setup();

      await callback(callbackContext(data, { from: { id: 42 } }));

      expect(cancelers.config.cancelPending).not.toHaveBeenCalled();
      expect(cancelers.configImport.cancelPending).not.toHaveBeenCalled();
      expect(cancelers.drive.cancelPending).not.toHaveBeenCalled();
      expect(cancelers.systemUpdate.cancelPending).not.toHaveBeenCalled();
      expect(launcher.launch).toHaveBeenCalledOnce();
    },
  );

  it('does not cancel without a user id but still delegates to HomeLauncher', async () => {
    const { callback, cancelers, launcher } = setup();
    const ctx = callbackContext('rh:f:c');

    await callback(ctx);

    expect(cancelers.config.cancelPending).not.toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalledWith(ctx);
  });
});
