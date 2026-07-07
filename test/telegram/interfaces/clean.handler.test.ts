import { describe, expect, it, vi } from 'vitest';
import { TriggerCleanUseCase } from '../../../src/camera/application/trigger-clean.use-case';
import { CleanHandler } from '../../../src/telegram/interfaces/clean.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

function createTestSetup(executed = true, thresholdUsed = 80) {
  const triggerClean = {
    execute: vi.fn(async (thresh?: number) => ({
      executed,
      thresholdUsed: thresh ?? thresholdUsed,
    })),
  } as unknown as TriggerCleanUseCase;

  const guard = {
    adminOnly: vi.fn(),
  } as unknown as RoleMiddleware;

  const handler = new CleanHandler(triggerClean, guard);

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
    triggerClean,
    guard,
    composer,
    commandCallbacks,
    callbackQueryCallbacks,
  };
}

describe('CleanHandler', () => {
  it('registers /clean command and clean:trigger/menu:clean callback queries', () => {
    const { composer } = createTestSetup();
    expect(composer.command).toHaveBeenCalledWith('clean', expect.anything(), expect.anything());
    expect(composer.callbackQuery).toHaveBeenCalledWith(expect.any(RegExp), expect.anything(), expect.anything());
  });

  it('executes cleanup without arguments on /clean command', async () => {
    const { commandCallbacks, triggerClean } = createTestSetup(true, 80);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, match: '' };

    await commandCallbacks.clean(ctx);

    expect(triggerClean.execute).toHaveBeenCalledWith(undefined);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('threshold used: *80%*'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });

  it('executes cleanup with custom threshold argument on /clean command', async () => {
    const { commandCallbacks, triggerClean } = createTestSetup(true, 75);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, match: '75' };

    await commandCallbacks.clean(ctx);

    expect(triggerClean.execute).toHaveBeenCalledWith(75);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('threshold used: *75%*'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });

  it('rejects invalid threshold argument', async () => {
    const { commandCallbacks, triggerClean } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, match: '150' };

    await commandCallbacks.clean(ctx);

    expect(triggerClean.execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('Invalid threshold'));
  });

  it('reports in-progress when cleanup lock is held', async () => {
    const { commandCallbacks, triggerClean } = createTestSetup(false, 80);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, match: '' };

    await commandCallbacks.clean(ctx);

    expect(triggerClean.execute).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
  });

  it('executes cleanup on clean:trigger callback query', async () => {
    const { callbackQueryCallbacks, triggerClean } = createTestSetup(true, 80);
    const cbFn = callbackQueryCallbacks[0].fn;

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { answerCallbackQuery, reply, match: ['clean:trigger'] };

    await cbFn(ctx);

    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(triggerClean.execute).toHaveBeenCalledWith(undefined);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('threshold used: *80%*'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });
});
