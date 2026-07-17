import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { GdriveAuthHandler } from '../../../src/telegram/interfaces/gdrive-auth.handler';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'drive-setup', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-storage' } },
};

function setup() {
  const events: string[] = [];
  const update = { execute: vi.fn().mockResolvedValue({ usedBytes: 1, totalBytes: 2, freeBytes: 1 }) };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const drafts = new WorkflowDraftRegistry();
  const navigation = { complete: vi.fn(async (_ctx, _launch, presentation) => {
    await presentation.deliver(); events.push('restore');
  }) };
  const handler = new GdriveAuthHandler(update as never, {} as never, workflows as never, drafts, navigation as never);
  const commands: Record<string, (...args: any[]) => Promise<void>> = {};
  const callbacks: { matcher: RegExp; fn: (...args: any[]) => Promise<void> }[] = [];
  const listeners: Record<string, (...args: any[]) => Promise<void>> = {};
  handler.register({
    command: vi.fn((name, _guard, fn) => { commands[name] = fn; }),
    callbackQuery: vi.fn((matcher, _guard, fn) => { callbacks.push({ matcher, fn }); }),
    on: vi.fn((name, fn) => { listeners[name] = fn; }),
  } as never);
  const ctx = {
    from: { id: 42 }, chat: { id: 42, type: 'private' },
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
    reply: vi.fn(async () => { events.push('result'); }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
  return { handler, update, workflows, navigation, commands, callbacks, listeners, ctx, events };
}

describe('GdriveAuthHandler contextual workflow', () => {
  it('begins the direct Storage setup receipt and uses a receipt-bound auth callback grammar', async () => {
    const { commands, ctx, workflows } = setup();

    await commands.gdrive_auth(ctx);

    const callbacks = ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard.flat()
      .map((button: { callback_data?: string }) => button.callback_data);
    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'drive-setup', { source: 'natural-parent' });
    expect(callbacks).toEqual(expect.arrayContaining([`gdauth:${receipt.id}:c`, `wr:${receipt.id}:h`]));
  });

  it('rejects a stale auth callback before it changes the active wizard', async () => {
    const { commands, callbacks, ctx, update, handler } = setup();
    await commands.gdrive_auth(ctx);
    ctx.callbackQuery = { data: 'gdauth:qrstuvwxyzabcdef:c' };

    await callbacks[0].fn(ctx);

    expect(update.execute).not.toHaveBeenCalled();
    expect((handler as unknown as { states: Map<string, unknown> }).states.has('42:42')).toBe(true);
  });

  it('delivers a valid credential result before asking navigation to restore the origin', async () => {
    const { commands, listeners, ctx, update, navigation, events } = setup();
    await commands.gdrive_auth(ctx);
    ctx.message = { text: '[gdrive]\ntype = drive' };

    await listeners['message:text'](ctx, vi.fn().mockResolvedValue(undefined));

    expect(update.execute).toHaveBeenCalledWith('[gdrive]\ntype = drive');
    expect(navigation.complete).toHaveBeenCalledOnce();
    expect(events).toEqual(['result', 'result', 'restore']);
  });

  it('marks the setup receipt running before writing credentials', async () => {
    const { commands, listeners, ctx, update, workflows } = setup();
    const events: string[] = [];
    await commands.gdrive_auth(ctx);
    ctx.message = { text: '[gdrive]\ntype = drive' };
    workflows.markRunning.mockImplementation(async () => {
      events.push('mark-running');
      return true;
    });
    update.execute.mockImplementation(async () => {
      events.push('write-credentials');
      return { usedBytes: 1, totalBytes: 2, freeBytes: 1 };
    });

    await listeners['message:text'](ctx, vi.fn().mockResolvedValue(undefined));

    expect(events).toEqual(['mark-running', 'write-credentials']);
  });

  it('calls next for /cancel when another workflow owns the conversation', async () => {
    const { commands, ctx } = setup();
    const next = vi.fn().mockResolvedValue(undefined);

    await commands.cancel(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
