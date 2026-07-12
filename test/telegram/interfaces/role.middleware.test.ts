import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function context(role: 'admin' | 'user', locale: 'en' | 'uk' = 'en'): TelegramContext {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    localeState: {
      user: {
        telegramId: 42,
        name: 'Oksana',
        role,
        locale,
        muted: false,
        quietStart: null,
        quietEnd: null,
        createdAt: null,
      },
      locale,
      catalog: catalogFor(locale),
    },
  } as TelegramContext;
}

describe('RoleMiddleware', () => {
  it('replies with the resolved Ukrainian catalog for a non-admin', async () => {
    const guard = new RoleMiddleware();
    const ctx = context('user', 'uk');
    const next = vi.fn();

    await guard.adminOnly(ctx, next);

    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('uk').common.adminRequired);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a resolved admin through without another repository lookup', async () => {
    const guard = new RoleMiddleware();
    const ctx = context('admin');
    const next = vi.fn().mockResolvedValue(undefined);

    await guard.adminOnly(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects missing locale state without replying in a fallback language', async () => {
    const guard = new RoleMiddleware();
    const ctx = { reply: vi.fn() } as unknown as TelegramContext;
    const next = vi.fn();

    await guard.registered(ctx, next);
    await guard.adminOnly(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
