import { describe, expect, it, vi } from 'vitest';
import { MenuHandler } from '../../../src/telegram/interfaces/menu.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

describe('MenuHandler', () => {
  function createTestSetup() {
    const guard = {
      registered: vi.fn(),
      resolveRole: vi.fn().mockResolvedValue('user'),
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
    const { commandCallbacks, guard } = createTestSetup();
    (guard.resolveRole as any).mockResolvedValue('admin');

    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: 999 },
      reply,
    };

    await commandCallbacks.menu(ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain('Interactive Command Dashboard');
    expect(reply.mock.calls[0][1]).toHaveProperty('reply_markup');
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
    const { callbackQueryCallbacks, statusHandler, healthHandler, logsHandler, muteHandler, unmuteHandler, guard, settingsHandler, cleanHandler } =
      createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const reply = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn().mockResolvedValue(true);

    // Test status delegation
    const statusCtx = {
      from: { id: 100 },
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
      match: ['menu:act:unmute_all', 'act:unmute_all'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(unmuteAllCtx);
    expect(unmuteHandler.handleUnmuteAll).toHaveBeenCalledWith(unmuteAllCtx);

    // Test settings delegation
    const settingsCtx = {
      from: { id: 100 },
      match: ['menu:settings', 'settings'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(settingsCtx);
    expect(settingsCtx.reply).toHaveBeenCalledWith(expect.stringContaining('Admin access required'));

    // Admin settings delegation
    (guard.resolveRole as any).mockResolvedValue('admin');
    await cbFn(settingsCtx);
    expect(settingsHandler.handleCommand).toHaveBeenCalledWith(settingsCtx);

    // Admin clean delegation
    const cleanCtx = {
      from: { id: 100 },
      match: ['menu:clean', 'clean'],
      answerCallbackQuery,
      reply,
      editMessageText,
    };
    await cbFn(cleanCtx);
    expect(cleanHandler.handleCommand).toHaveBeenCalledWith(cleanCtx);
  });
});
