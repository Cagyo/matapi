import { Composer } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { ReturnHomeHandler } from '../../../src/telegram/interfaces/return-home.handler';
import type { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function setup() {
  const guard = { registered: vi.fn() };
  const handler = new ReturnHomeHandler(guard as unknown as RoleMiddleware);
  let regex!: RegExp;
  let callback!: (ctx: TelegramContext) => Promise<void>;
  const composer = { callbackQuery: vi.fn((filter: RegExp, _guard: unknown, fn: typeof callback) => { regex = filter; callback = fn; }) } as unknown as Composer<TelegramContext>;
  handler.register(composer);
  return { callback, composer, guard, regex };
}

function context(overrides: Partial<TelegramContext> = {}): TelegramContext {
  return {
    from: { id: 7 }, chat: { id: 70, type: 'private' }, callbackQuery: { data: 'rh:f:c' },
    answerCallbackQuery: vi.fn().mockResolvedValue(true), reply: vi.fn().mockResolvedValue({}),
    localeState: {
      locale: 'en', catalog: catalogFor('en'),
      user: { telegramId: 7, name: 'User', role: 'user', locale: 'en', muted: false, nonCriticalPausedUntil: null, notificationPauseRevision: 0, quietStart: null, quietEnd: null, createdAt: null },
    },
    ...overrides,
  } as unknown as TelegramContext;
}

describe('ReturnHomeHandler compatibility route', () => {
  it('registers only the exact one-release rh grammar behind registered-user policy', () => {
    const { composer, guard, regex } = setup();
    expect(composer.callbackQuery).toHaveBeenCalledWith(expect.any(RegExp), guard.registered, expect.any(Function));
    expect(regex.source).toBe('^rh:[lcsfidua]:[crt](?![\\s\\S])');
    expect(regex.test('rh:a:c')).toBe(true);
    expect(regex.test('rh:a:c\n')).toBe(false);
  });

  it('acknowledges once and directs the current private user to the localized /menu command', async () => {
    const { callback } = setup();
    const ctx = context({ homeCallbackAcknowledged: true });
    await callback(ctx);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    const menuUsage = ctx.localeState?.catalog.commands.find((command) => command.command === 'menu')?.usage;
    expect(ctx.reply).toHaveBeenCalledWith(menuUsage);
  });

  it('best-effort acknowledges without cancelling or navigating any state', async () => {
    const { callback } = setup();
    const ctx = context({ answerCallbackQuery: vi.fn().mockRejectedValue(new Error('expired')) });
    await expect(callback(ctx)).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  it.each([
    ['unregistered', { localeState: undefined }],
    ['group', { chat: { id: -70, type: 'group' } }],
    ['mismatched identity', { from: { id: 8 } }],
  ])('does not reply for %s callbacks', async (_label, overrides) => {
    const { callback } = setup();
    const ctx = context(overrides as Partial<TelegramContext>);
    await callback(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
