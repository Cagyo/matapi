import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { BotCommandsMenuService } from '../../../src/telegram/application/bot-commands-menu.service';
import { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { SettingsHandler } from '../../../src/telegram/interfaces/settings.handler';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';

const languageReceipt = {
  id: 'AbCdEf0123_-xyZ9',
  userId: 100,
  chatId: 100,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: {
    workflow: 'language',
    phase: 'cancellable',
    originSource: 'natural-parent',
    origin: { kind: 'more' },
  },
} satisfies WorkflowReturnReceipt;

function callbackData(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const keyboard = (options as {
    reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
  }).reply_markup;
  return keyboard?.inline_keyboard?.flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string') ?? [];
}

function keyboardText(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const keyboard = (options as {
    reply_markup?: { inline_keyboard?: { text?: string }[][] };
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

function fixturePrivateChat(ctx: any): any {
  if (!ctx.chat && typeof ctx.from?.id === 'number') {
    ctx.chat = { id: ctx.from.id, type: 'private' };
  }
  return ctx;
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
  const workflows = { begin: vi.fn().mockResolvedValue(languageReceipt) };
  const drafts = new WorkflowDraftRegistry();
  const navigation = {
    complete: vi.fn(async (
      _ctx: unknown,
      launch: { receipt: WorkflowReturnReceipt },
      presentation: { effectStage: 'pending' | 'already-delivered'; deliver(): Promise<void> },
    ) => {
      if (presentation.effectStage === 'pending') await presentation.deliver();
      await drafts.cancelExact(launch.receipt);
    }),
  };
  const handler = new SettingsHandler(users, menus, guard, workflows as never, drafts, navigation as never);

  const commandCallbacks: Record<string, (...args: any[]) => any> = {};
  const callbackQueryCallbacks: { regex: RegExp; fn: (...args: any[]) => any }[] = [];
  const composer = {
    command: vi.fn((cmd, middleware, fn) => {
      const callback = fn || middleware;
      commandCallbacks[cmd] = async (ctx, ...args) => {
        await callback(fixturePrivateChat(ctx), ...args);
      };
    }),
    callbackQuery: vi.fn((regex, middleware, fn) => {
      const callback = fn || middleware;
      callbackQueryCallbacks.push({ regex, fn: async (ctx, ...args) => {
        await callback(fixturePrivateChat(ctx), ...args);
      } });
    }),
  } as any;
  handler.register(composer);

  return { meta, users, menus, guard, composer, commandCallbacks, callbackQueryCallbacks, workflows, drafts, navigation };
}

describe('SettingsHandler', () => {
  it('binds direct language selection to More and restores it in the selected locale', async () => {
    const { commandCallbacks, callbackQueryCallbacks, users, menus, composer, workflows, navigation } = createTestSetup('75');
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { from: { id: 100 }, localeState: localeState('user'), reply } as any;

    await commandCallbacks.settings(ctx);
    expect(composer.command).toHaveBeenCalledWith('settings', expect.anything(), expect.anything());
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Choose your language'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(reply.mock.calls[0][1])).toEqual([
      'settings:locale:AbCdEf0123_-xyZ9:en',
      'settings:locale:AbCdEf0123_-xyZ9:ru',
      'settings:locale:AbCdEf0123_-xyZ9:uk',
      'wr:AbCdEf0123_-xyZ9:o',
      'wr:AbCdEf0123_-xyZ9:h',
    ]);
    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'language', { source: 'natural-parent' });

    const localeCallback = callbackQueryCallbacks.find(({ regex }) => regex.test('settings:locale:AbCdEf0123_-xyZ9:uk'))!.fn;
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const localeContext = {
      from: { id: 100 },
      localeState: localeState('user'),
      answerCallbackQuery,
      reply,
      callbackQuery: { data: 'settings:locale:AbCdEf0123_-xyZ9:uk', message: { message_id: 123 } },
    } as any;
    await localeCallback(localeContext);

    expect(users.setLocale).toHaveBeenCalledWith(100, 'uk');
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.stringContaining('Мову змінено'));
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Мову змінено'),
    );
    expect(navigation.complete).toHaveBeenCalledWith(
      expect.anything(),
      { receipt: languageReceipt },
      expect.objectContaining({ effectStage: 'pending' }),
    );
    expect(localeContext.localeState).toEqual(expect.objectContaining({
      locale: 'uk',
      catalog: catalogFor('uk'),
    }));
    expect(menus.updateUserMenu).toHaveBeenCalledWith(100);
  });

  it('rejects an invalid or stale locale callback before persisting', async () => {
    const { callbackQueryCallbacks, commandCallbacks, users } = createTestSetup();
    const localeCallback = callbackQueryCallbacks.find(({ regex }) => regex.test('settings:locale:AbCdEf0123_-xyZ9:uk'))!.fn;
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    await commandCallbacks.settings({
      from: { id: 100 },
      localeState: localeState('user'),
      reply: vi.fn().mockResolvedValue(true),
    });

    await localeCallback({
      from: { id: 100 },
      localeState: localeState('user'),
      callbackQuery: { data: 'settings:locale:AbCdEf0123_-xyZ9:de' },
      answerCallbackQuery,
    });

    await localeCallback({
      from: { id: 100 },
      localeState: localeState('user'),
      callbackQuery: { data: 'settings:locale:ZyXwVu9876_-tsR5:uk' },
      answerCallbackQuery,
    });

    expect(users.setLocale).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects locale callbacks from a group or a different private chat', async () => {
    const { callbackQueryCallbacks, commandCallbacks, users } = createTestSetup();
    const localeCallback = callbackQueryCallbacks.find(({ regex }) => regex.test('settings:locale:AbCdEf0123_-xyZ9:uk'))!.fn;
    const reply = vi.fn().mockResolvedValue(true);
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);

    await commandCallbacks.settings({
      from: { id: 100 },
      chat: { id: 100, type: 'private' },
      localeState: localeState('user'),
      reply,
    });

    await localeCallback({
      from: { id: 100 },
      chat: { id: -100, type: 'group' },
      localeState: localeState('user'),
      callbackQuery: { data: 'settings:locale:AbCdEf0123_-xyZ9:uk' },
      answerCallbackQuery,
      reply,
    });
    await localeCallback({
      from: { id: 100 },
      chat: { id: 101, type: 'private' },
      localeState: localeState('user'),
      callbackQuery: { data: 'settings:locale:AbCdEf0123_-xyZ9:uk' },
      answerCallbackQuery,
      reply,
    });

    expect(users.setLocale).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledTimes(2);
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
      'settings:locale:AbCdEf0123_-xyZ9:en',
      'settings:locale:AbCdEf0123_-xyZ9:ru',
      'settings:locale:AbCdEf0123_-xyZ9:uk',
      'wr:AbCdEf0123_-xyZ9:o',
      'wr:AbCdEf0123_-xyZ9:h',
    ]);
  });

  it('retains a receipt-bound retry when language persistence fails', async () => {
    const { commandCallbacks, callbackQueryCallbacks, users } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    await commandCallbacks.settings({ from: { id: 100 }, localeState: localeState('user'), reply });
    (users.setLocale as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk unavailable'));
    const callback = callbackQueryCallbacks[0].fn;

    await callback({
      from: { id: 100 },
      localeState: localeState('user'),
      callbackQuery: { data: 'settings:locale:AbCdEf0123_-xyZ9:uk' },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      reply,
    });

    expect(reply).toHaveBeenCalledWith(
      catalogFor('en').language.updateFailed,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(reply.mock.calls[1][1])).toContain('settings:locale:AbCdEf0123_-xyZ9:uk');
    expect(keyboardText(reply.mock.calls[1][1])).toContain(catalogFor('en').language.retryLanguageChange);
  });
});
