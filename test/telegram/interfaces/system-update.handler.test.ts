import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { SystemUpdateHandler } from '../../../src/telegram/interfaces/system-update.handler';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'system-update', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-system' } },
};
const updateAvailable = {
  deps: [{ name: 'motion', current: '4.5.1', available: '4.6.0', kind: 'upgrade' as const }],
  hasUpdates: true,
  nodeMajorMismatch: false,
};

function setup() {
  const events: string[] = [];
  const update = {
    check: vi.fn().mockResolvedValue(updateAvailable),
    apply: vi.fn(async () => { events.push('apply'); }),
  };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    markRunning: vi.fn(async () => { events.push('running'); return true; }),
  };
  const handler = new SystemUpdateHandler(update as never, {} as never, workflows as never, new WorkflowDraftRegistry());
  const commands: Record<string, (...args: any[]) => Promise<void>> = {};
  handler.register({ command: vi.fn((name, _guard, fn) => { commands[name] = fn; }), callbackQuery: vi.fn(), on: vi.fn() } as never);
  const ctx = {
    from: { id: 42 }, chat: { id: 42, type: 'private' },
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
  return { handler, commands, update, workflows, ctx, events };
}

describe('SystemUpdateHandler contextual workflow', () => {
  it('begins the direct System workflow and binds Apply/Cancel to the receipt', async () => {
    const { handler, update, workflows, ctx } = setup();

    await handler.handleCommand(ctx as never);

    const callbacks = ctx.reply.mock.calls.at(-1)?.[1].reply_markup.inline_keyboard.flat()
      .map((button: { callback_data?: string }) => button.callback_data);
    expect(update.check).toHaveBeenCalledOnce();
    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'system-update', { source: 'natural-parent' });
    expect(callbacks).toEqual(expect.arrayContaining([
      `sysupd:${receipt.id}:a`, `sysupd:${receipt.id}:c`, `wr:${receipt.id}:h`,
    ]));
  });

  it('marks the exact receipt running before the first update apply side effect', async () => {
    const { handler, update, ctx, events } = setup();
    await handler.handleCommand(ctx as never);
    ctx.callbackQuery = { data: `sysupd:${receipt.id}:a` };

    await (handler as unknown as { onCallback(context: object): Promise<void> }).onCallback(ctx);

    expect(events).toEqual(['running', 'apply']);
    expect(update.apply).toHaveBeenCalledOnce();
  });

  it('rejects stale update buttons before changing markup, state, or applying packages', async () => {
    const { handler, update, ctx } = setup();
    await handler.handleCommand(ctx as never);
    ctx.callbackQuery = { data: 'sysupd:qrstuvwxyzabcdef:a' };

    await (handler as unknown as { onCallback(context: object): Promise<void> }).onCallback(ctx);

    expect(update.apply).not.toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect((handler as unknown as { pending: Map<string, unknown> }).pending.has('42:42')).toBe(true);
  });

  it('calls next for /cancel when another workflow owns the current conversation', async () => {
    const { commands, ctx } = setup();
    const next = vi.fn().mockResolvedValue(undefined);

    await commands.cancel(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
