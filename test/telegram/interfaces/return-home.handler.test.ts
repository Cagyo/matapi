import { Composer } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { HomeLauncher } from '../../../src/telegram/interfaces/home-launcher';
import { ReturnHomeHandler } from '../../../src/telegram/interfaces/return-home.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
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
  const handler = new ReturnHomeHandler(launcher, guard);
  let capturedRegex!: RegExp;
  let callback!: (ctx: TelegramContext) => Promise<void>;
  const composer = {
    callbackQuery: vi.fn((regex: RegExp, _middleware: unknown, fn: typeof callback) => {
      capturedRegex = regex;
      callback = fn;
    }),
  } as unknown as Composer<TelegramContext>;

  handler.register(composer);

  return { launcher, guard, composer, capturedRegex, callback };
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
});
