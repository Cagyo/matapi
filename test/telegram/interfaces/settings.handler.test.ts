import { describe, expect, it, vi } from 'vitest';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { SettingsHandler } from '../../../src/telegram/interfaces/settings.handler';

function createTestSetup(metaValue: string | null = null) {
  const meta = {
    get: vi.fn(async () => metaValue),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as SystemMetaRepositoryPort;

  const guard = {
    adminOnly: vi.fn(),
  } as unknown as RoleMiddleware;

  const handler = new SettingsHandler(meta, guard);

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
    meta,
    guard,
    composer,
    commandCallbacks,
    callbackQueryCallbacks,
  };
}

describe('SettingsHandler', () => {
  it('registers /settings command and settings:set:* callback query', () => {
    const { composer } = createTestSetup();
    expect(composer.command).toHaveBeenCalledWith('settings', expect.anything(), expect.anything());
    expect(composer.callbackQuery).toHaveBeenCalledWith(expect.any(RegExp), expect.anything(), expect.anything());
  });

  it('renders dashboard on /settings command with current threshold', async () => {
    const { commandCallbacks } = createTestSetup('75');
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply };

    await commandCallbacks.settings(ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain('*Auto Clean Trigger Threshold:* 75%');
    expect(reply.mock.calls[0][1]).toHaveProperty('reply_markup');
  });

  it('updates threshold when preset button is clicked and edits message', async () => {
    const { callbackQueryCallbacks, meta } = createTestSetup('80');
    const cbFn = callbackQueryCallbacks[0].fn;

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageText = vi.fn().mockResolvedValue(true);
    const ctx = {
      match: ['settings:set:85', '85'],
      answerCallbackQuery,
      editMessageText,
      callbackQuery: { message: { message_id: 123 } },
    };

    await cbFn(ctx);

    expect(meta.set).toHaveBeenCalledWith('auto_clean_threshold', '85');
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.stringContaining('85%'));
    expect(editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Auto Clean Trigger Threshold:'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('rejects out of bounds threshold in callback query', async () => {
    const { callbackQueryCallbacks, meta } = createTestSetup('80');
    const cbFn = callbackQueryCallbacks[0].fn;

    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const ctx = {
      match: ['settings:set:5', '5'],
      answerCallbackQuery,
    };

    await cbFn(ctx);

    expect(meta.set).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Invalid threshold'), show_alert: true }),
    );
  });
});
