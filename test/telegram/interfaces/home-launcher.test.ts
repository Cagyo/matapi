import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { OpenHomeUseCase } from '../../../src/telegram/application/open-home.use-case';
import { HomeLauncher } from '../../../src/telegram/interfaces/home-launcher';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function privateContext({
  locale = 'en',
  role = 'user',
  messageId,
}: {
  locale?: 'en' | 'uk';
  role?: 'admin' | 'user';
  messageId?: number;
} = {}): TelegramContext {
  return {
    from: { id: 100 },
    chat: { id: 100, type: 'private' },
    callbackQuery: messageId === undefined ? undefined : { message: { message_id: messageId } },
    localeState: {
      user: {
        telegramId: 100,
        name: 'Alex',
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
    reply: vi.fn().mockResolvedValue({ message_id: 101 }),
    editMessageText: vi.fn(),
  } as unknown as TelegramContext;
}

describe('HomeLauncher', () => {
  it('opens a new Home using only current private locale state', async () => {
    const openHome = { execute: vi.fn().mockResolvedValue({ kind: 'opened' }) };
    const launcher = new HomeLauncher(openHome as unknown as OpenHomeUseCase);
    const ctx = privateContext({ locale: 'uk', role: 'admin', messageId: 99 });

    await expect(launcher.launch(ctx)).resolves.toBe('opened');

    expect(openHome.execute).toHaveBeenCalledWith({
      userId: 100,
      chatId: 100,
      locale: 'uk',
      role: 'admin',
      view: { kind: 'home', checking: false },
    });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it('uses stale recovery after promotion loss and unavailable recovery after send failure', async () => {
    const openHome = { execute: vi.fn() };
    const launcher = new HomeLauncher(openHome as unknown as OpenHomeUseCase);
    const ctx = privateContext();

    openHome.execute.mockResolvedValueOnce({ kind: 'superseded' });
    await expect(launcher.launch(ctx)).resolves.toBe('superseded');
    expect(ctx.reply).toHaveBeenCalledWith(
      ctx.localeState!.catalog.home.recovery.stale,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup)).toContain('ho');

    openHome.execute.mockRejectedValueOnce(new Error('Telegram unavailable'));
    await expect(launcher.launch(ctx)).resolves.toBe('unavailable');
    expect(ctx.reply).toHaveBeenLastCalledWith(
      ctx.localeState!.catalog.home.recovery.unavailable,
    );
  });

  it('retains the result when recovery delivery fails', async () => {
    const openHome = { execute: vi.fn() };
    const launcher = new HomeLauncher(openHome as unknown as OpenHomeUseCase);
    const ctx = privateContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Telegram unavailable'));

    openHome.execute.mockResolvedValueOnce({ kind: 'superseded' });
    await expect(launcher.launch(ctx)).resolves.toBe('superseded');

    openHome.execute.mockRejectedValueOnce(new Error('Home send failed'));
    await expect(launcher.launch(ctx)).resolves.toBe('unavailable');
  });

  it.each([
    ['from is missing', (ctx: TelegramContext) => { delete (ctx as { from?: unknown }).from; }],
    ['chat is not private', (ctx: TelegramContext) => { (ctx as { chat: { type: string } }).chat.type = 'group'; }],
    ['locale state is missing', (ctx: TelegramContext) => { delete ctx.localeState; }],
    ['locale state belongs to another Telegram user', (ctx: TelegramContext) => { ctx.localeState!.user.telegramId = 101; }],
  ])('ignores the launch when %s', async (_reason, invalidate) => {
    const openHome = { execute: vi.fn() };
    const launcher = new HomeLauncher(openHome as unknown as OpenHomeUseCase);
    const ctx = privateContext();
    invalidate(ctx);

    await expect(launcher.launch(ctx)).resolves.toBe('ignored');

    expect(openHome.execute).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
