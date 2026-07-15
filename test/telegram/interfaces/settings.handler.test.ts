import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { SettingsHandler } from '../../../src/telegram/interfaces/settings.handler';

function callbackData(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const keyboard = (options as {
    reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
  }).reply_markup;
  return keyboard?.inline_keyboard?.flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string') ?? [];
}

function keyboardText(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const keyboard = (options as {
    reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> };
  }).reply_markup;
  return keyboard?.inline_keyboard?.flat()
    .map((button) => button.text)
    .filter((text): text is string => typeof text === 'string') ?? [];
}

function localeState(role: 'admin' | 'user', locale: 'en' | 'ru' | 'uk' = 'en') {
  return {
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
  };
}

function createTestSetup(metaValue: string | null = null) {
  const meta = {
    get: vi.fn(async () => metaValue),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as SystemMetaRepositoryPort;
  const users = {
    setLocale: vi.fn(async (telegramId: number, locale: 'en' | 'ru' | 'uk') => ({
      ...localeState('user', locale).user,
      telegramId,
    })),
  } as unknown as UserRepositoryPort;
  const menus = { updateUserMenu: vi.fn().mockResolvedValue(undefined) } as unknown as BotCommandsMenuService;
  const guard = { registered: vi.fn(), adminOnly: vi.fn() } as unknown as RoleMiddleware;
  const handler = new SettingsHandler(users, menus, guard);

  const commandCallbacks: Record<string, (...args: any[]) => any> = {};
  const callbackQueryCallbacks: { regex: RegExp; fn: (...args: any[]) => any }[] = [];
  const composer = {
    command: vi.fn((cmd, middleware, fn) => { commandCallbacks[cmd] = fn || middleware; }),
    callbackQuery: vi.fn((regex, middleware, fn) => { callbackQueryCallbacks.push({ regex, fn: fn || middleware }); }),
  } as any;
  handler.register(composer);

  return { meta, users, menus, guard, composer, commandCallbacks, callbackQueryCallbacks };
}

describe('SettingsHandler', () => {
  it('lets a registered non-admin change locale before queuing a refreshed menu', async () => {
    const { commandCallbacks, callbackQueryCallbacks, users, menus, composer } = createTestSetup('75');
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 100 }, localeState: localeState('user'), reply } as any;

    await commandCallbacks.settings(ctx);
    expect(composer.command).toHaveBeenCalledWith('settings', expect.anything(), expect.anything());
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Choose your language'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(reply.mock.calls[0][1])).toEqual([
      'settings:locale:en',
      'settings:locale:ru',
      'settings:locale:uk',
      'rh:s:c',
    ]);

    const localeCallback = callbackQueryCallbacks.find(({ regex }) => regex.test('settings:locale:uk'))!.fn;
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn().mockResolvedValue(true);
    await localeCallback({
      from: { id: 100 },
      match: ['settings:locale:uk', 'uk'],
      localeState: localeState('user'),
      answerCallbackQuery,
      editMessageText,
      callbackQuery: { message: { message_id: 123 } },
    });

    expect(users.setLocale).toHaveBeenCalledWith(100, 'uk');
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.stringContaining('Мову змінено'));
    expect(editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Виберіть мову'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(editMessageText.mock.calls[0][1])).toEqual([
      'settings:locale:en',
      'settings:locale:ru',
      'settings:locale:uk',
      'rh:s:c',
    ]);
    expect(keyboardText(editMessageText.mock.calls[0][1])).toContain('🏠 Дім');
    expect(menus.updateUserMenu).toHaveBeenCalledWith(100);
  });

  it('rejects invalid locale callback data without persisting', async () => {
    const { callbackQueryCallbacks, users } = createTestSetup();
    const localeCallback = callbackQueryCallbacks.find(({ regex }) => regex.test('settings:locale:uk'))!.fn;
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);

    await localeCallback({
      from: { id: 100 },
      match: ['settings:locale:de', 'de'],
      localeState: localeState('user'),
      answerCallbackQuery,
    });

    expect(users.setLocale).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  it.each(['user', 'admin'] as const)('renders only personal locale settings for %s', async (role) => {
    const { callbackQueryCallbacks, commandCallbacks } = createTestSetup('80');
    const reply = vi.fn().mockResolvedValue(true);

    await commandCallbacks.settings({ from: { id: 100 }, localeState: localeState(role), reply });

    expect(callbackQueryCallbacks.some(({ regex }) => regex.test('settings:set:85'))).toBe(false);
    const text = reply.mock.calls[0][0] as string;
    const callbacks = callbackData(reply.mock.calls[0][1]);
    expect(text).not.toContain('System settings');
    expect(callbacks).toEqual([
      'settings:locale:en',
      'settings:locale:ru',
      'settings:locale:uk',
      'rh:s:c',
    ]);
  });
});
