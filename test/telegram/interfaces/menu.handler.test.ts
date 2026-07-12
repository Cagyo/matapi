import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { MenuHandler } from '../../../src/telegram/interfaces/menu.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

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

describe('MenuHandler', () => {
  function createTestSetup() {
    const guard = {
      registered: vi.fn(),
    } as unknown as RoleMiddleware;

    const statusHandler = { handleCommand: vi.fn() } as any;
    const healthHandler = { handleCommand: vi.fn() } as any;
    const cameraHandler = { handleStatus: vi.fn(), handleDashboard: vi.fn() } as any;
    const gdriveHandler = { handleStatus: vi.fn() } as any;
    const inviteHandler = { handleCommand: vi.fn() } as any;
    const exportConfigHandler = { handleCommand: vi.fn() } as any;
    const logsHandler = { handleEmpty: vi.fn() } as any;
    const muteHandler = { handleEmpty: vi.fn(), handleMuteAll: vi.fn() } as any;
    const unmuteHandler = { handleEmpty: vi.fn(), handleUnmuteAll: vi.fn() } as any;
    const configHandler = { handleSubcommand: vi.fn() } as any;
    const importConfigHandler = { handleCommand: vi.fn() } as any;
    const systemUpdateHandler = { handleCommand: vi.fn() } as any;
    const restartHandler = { handleCommand: vi.fn() } as any;
    const quietHoursHandler = { handlePreset: vi.fn() } as any;
    const settingsHandler = { handleCommand: vi.fn() } as any;
    const cleanHandler = { handleCommand: vi.fn() } as any;
    const gdriveAuthHandler = { handleCommand: vi.fn() } as any;
    const csvHandler = { handleEmpty: vi.fn() } as any;

    const handler = new MenuHandler(
      guard,
      statusHandler,
      healthHandler,
      cameraHandler,
      gdriveHandler,
      inviteHandler,
      exportConfigHandler,
      logsHandler,
      muteHandler,
      unmuteHandler,
      configHandler,
      importConfigHandler,
      systemUpdateHandler,
      restartHandler,
      quietHoursHandler,
      settingsHandler,
      cleanHandler,
      gdriveAuthHandler,
      csvHandler,
    );

    const commandCallbacks: Record<string, (...args: any[]) => any> = {};
    const callbackQueryCallbacks: { regex: RegExp; fn: (...args: any[]) => any }[] = [];

    const composer = {
      command: vi.fn((cmd, middleware, fn) => {
        commandCallbacks[cmd] = fn || middleware;
      }),
      callbackQuery: vi.fn((regex, middleware, fn) => {
        callbackQueryCallbacks.push({ regex, fn: fn || middleware });
      }),
    } as any;

    handler.register(composer);

    return {
      handler,
      guard,
      composer,
      commandCallbacks,
      callbackQueryCallbacks,
      statusHandler,
      healthHandler,
      cameraHandler,
      gdriveHandler,
      inviteHandler,
      exportConfigHandler,
      logsHandler,
      muteHandler,
      unmuteHandler,
      configHandler,
      importConfigHandler,
      systemUpdateHandler,
      restartHandler,
      quietHoursHandler,
      settingsHandler,
      cleanHandler,
      gdriveAuthHandler,
      csvHandler,
    };
  }

  it('registers /menu command and menu:* callback query', () => {
    const { composer } = createTestSetup();
    expect(composer.command).toHaveBeenCalledWith(
      'menu',
      expect.anything(),
      expect.anything(),
    );
    expect(composer.callbackQuery).toHaveBeenCalledWith(
      expect.any(RegExp),
      expect.anything(),
      expect.anything(),
    );
  });

  it('responds with title and interactive keyboard on /menu command', async () => {
    const { commandCallbacks } = createTestSetup();

    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: 999 },
      localeState: localeState('admin'),
      reply,
    };

    await commandCallbacks.menu(ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain('Interactive Command Dashboard');
    expect(reply.mock.calls[0][1]).toHaveProperty('reply_markup');
  });

  it('uses the current user catalog and exposes settings to ordinary users', async () => {
    const { commandCallbacks, callbackQueryCallbacks, settingsHandler } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const userCtx = { from: { id: 100 }, localeState: localeState('user', 'uk'), reply };

    await commandCallbacks.menu(userCtx);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Інтерактивна панель команд'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify(reply.mock.calls[0][1].reply_markup)).toContain('menu:settings');

    const settingsCtx = {
      from: { id: 100 },
      localeState: localeState('user', 'uk'),
      match: ['menu:settings', 'settings'],
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      reply,
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    await callbackQueryCallbacks[0].fn(settingsCtx);
    expect(settingsHandler.handleCommand).toHaveBeenCalledWith(settingsCtx);
  });

  it('shows Export CSV in the dashboard and Sensors submenu', async () => {
    const { commandCallbacks, callbackQueryCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn().mockResolvedValue(true);
    const menuContext = { from: { id: 999 }, reply };
    const sensorSubmenuContext = {
      from: { id: 999 },
      match: ['menu:sub:sensors', 'sub:sensors'],
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      reply,
      editMessageText,
    };

    await commandCallbacks.menu(menuContext);
    expect(JSON.stringify(reply.mock.calls[0][1].reply_markup)).toContain('menu:sub:csv');

    await callbackQueryCallbacks[0].fn(sensorSubmenuContext);
    expect(JSON.stringify(editMessageText.mock.calls.at(-1)?.[1].reply_markup)).toContain(
      'menu:sub:csv',
    );
  });

  it('delegates the CSV submenu with menu origin', async () => {
    const { callbackQueryCallbacks, csvHandler } = createTestSetup();
    const csvSubmenuContext = {
      from: { id: 100 },
      match: ['menu:sub:csv', 'sub:csv'],
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      reply: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    };

    await callbackQueryCallbacks[0].fn(csvSubmenuContext);

    expect(csvHandler.handleEmpty).toHaveBeenCalledWith(csvSubmenuContext, 'menu');
  });

  it('delegates action callbacks and renders interactive submenus', async () => {
    const { callbackQueryCallbacks, statusHandler, healthHandler, logsHandler, muteHandler, unmuteHandler, settingsHandler, cleanHandler } =
      createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const reply = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn().mockResolvedValue(true);

    // Test status delegation
    const statusCtx = {
      from: { id: 100 },
      localeState: localeState('user'),
      match: ['menu:status', 'status'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(statusCtx);
    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(statusHandler.handleCommand).toHaveBeenCalledWith(statusCtx);

    // Test non-admin access to health
    const healthCtx = {
      from: { id: 100 },
      localeState: localeState('user'),
      match: ['menu:health', 'health'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(healthCtx);
    expect(healthHandler.handleCommand).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Admin access required'),
    );

    // Test submenu navigation (sub:sensors)
    const sensorsCtx = {
      from: { id: 100 },
      localeState: localeState('user'),
      match: ['menu:sub:sensors', 'sub:sensors'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(sensorsCtx);
    expect(editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Sensor Operations'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify(editMessageText.mock.calls[0][1].reply_markup)).toContain('« Back');

    // Test logs delegation
    const logsCtx = {
      from: { id: 100 },
      localeState: localeState('user'),
      match: ['menu:sub:logs', 'sub:logs'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(logsCtx);
    expect(logsHandler.handleEmpty).toHaveBeenCalledWith(logsCtx);

    // Test mute all delegation
    const muteAllCtx = {
      from: { id: 100 },
      localeState: localeState('user'),
      match: ['menu:act:mute_all', 'act:mute_all'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(muteAllCtx);
    expect(muteHandler.handleMuteAll).toHaveBeenCalledWith(muteAllCtx);

    // Test unmute all delegation
    const unmuteAllCtx = {
      from: { id: 100 },
      localeState: localeState('user'),
      match: ['menu:act:unmute_all', 'act:unmute_all'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(unmuteAllCtx);
    expect(unmuteHandler.handleUnmuteAll).toHaveBeenCalledWith(unmuteAllCtx);

    // Settings is a user-level language entry; the settings handler keeps
    // threshold controls admin-only internally.
    const settingsCtx = {
      from: { id: 100 },
      match: ['menu:settings', 'settings'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(settingsCtx);
    expect(settingsHandler.handleCommand).toHaveBeenCalledWith(settingsCtx);

    // Admin settings delegation
    const adminSettingsCtx = { ...settingsCtx, localeState: localeState('admin') };
    await cbFn(adminSettingsCtx);
    expect(settingsHandler.handleCommand).toHaveBeenCalledWith(adminSettingsCtx);

    // Admin clean delegation
    const cleanCtx = {
      from: { id: 100 },
      localeState: localeState('admin'),
      match: ['menu:clean', 'clean'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(cleanCtx);
    expect(cleanHandler.handleCommand).toHaveBeenCalledWith(cleanCtx);
  });
});
