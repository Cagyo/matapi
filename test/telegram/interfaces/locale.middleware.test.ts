import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { LocaleMiddleware } from '../../../src/telegram/interfaces/locale.middleware';
import { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function context(telegramId?: number): TelegramContext {
  return {
    from: telegramId === undefined ? undefined : { id: telegramId },
  } as TelegramContext;
}

describe('LocaleMiddleware', () => {
  it('attaches a Ukrainian registered user and catalog before continuing', async () => {
    const users = {
      findByTelegramId: vi.fn().mockResolvedValue({
        telegramId: 42,
        name: 'Oksana',
        role: 'user',
        locale: 'uk',
        muted: false,
        quietStart: null,
        quietEnd: null,
        createdAt: null,
      }),
    };
    const middleware = new LocaleMiddleware(users);
    const ctx = context(42);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware.resolveRegistered(ctx, next);

    expect(users.findByTelegramId).toHaveBeenCalledWith(42);
    expect(ctx.localeState?.locale).toBe('uk');
    expect(ctx.localeState?.catalog).toBe(catalogFor('uk'));
    expect(next).toHaveBeenCalledOnce();
  });

  it('continues optional resolution without locale state for an unregistered user', async () => {
    const users = { findByTelegramId: vi.fn().mockResolvedValue(null) };
    const middleware = new LocaleMiddleware(users);
    const ctx = context(99);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware.resolveOptional(ctx, next);

    expect(ctx.localeState).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips lookup when an update has no sender', async () => {
    const users = { findByTelegramId: vi.fn() };
    const middleware = new LocaleMiddleware(users);
    const ctx = context();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware.resolveOptional(ctx, next);

    expect(users.findByTelegramId).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('normalizes an invalid persisted locale to English', async () => {
    const users = {
      findByTelegramId: vi.fn().mockResolvedValue({
        telegramId: 42,
        name: 'Oksana',
        role: 'user',
        locale: 'de',
        muted: false,
        quietStart: null,
        quietEnd: null,
        createdAt: null,
      }),
    };
    const middleware = new LocaleMiddleware(users);
    const ctx = context(42);

    await middleware.resolveRegistered(ctx, vi.fn().mockResolvedValue(undefined));

    expect(ctx.localeState?.locale).toBe('en');
    expect(ctx.localeState?.catalog).toBe(catalogFor('en'));
    expect(ctx.localeState?.user.locale).toBe('en');
  });
});
