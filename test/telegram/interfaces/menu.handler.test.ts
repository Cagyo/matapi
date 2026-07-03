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
    const cameraHandler = { handleStatus: vi.fn() } as any;
    const gdriveHandler = { handleStatus: vi.fn() } as any;
    const inviteHandler = { handleCommand: vi.fn() } as any;
    const exportConfigHandler = { handleCommand: vi.fn() } as any;

    const handler = new MenuHandler(
      guard,
      statusHandler,
      healthHandler,
      cameraHandler,
      gdriveHandler,
      inviteHandler,
      exportConfigHandler,
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

  it('delegates action callbacks to handlers or replies with usage', async () => {
    const { callbackQueryCallbacks, statusHandler, healthHandler } =
      createTestSetup();
    const cbFn = callbackQueryCallbacks[0].fn;

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const reply = vi.fn().mockResolvedValue(true);

    // Test status delegation
    const statusCtx = {
      from: { id: 100 },
      match: ['menu:status', 'status'],
      answerCallbackQuery,
      reply,
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
    };
    await cbFn(healthCtx);
    expect(healthHandler.handleCommand).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Admin access required'),
    );
  });
});
