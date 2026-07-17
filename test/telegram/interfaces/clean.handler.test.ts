import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { CleanHandler } from '../../../src/telegram/interfaces/clean.handler';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'storage-cleanup', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-storage' } },
};

function setup() {
  const events: string[] = [];
  const clean = { execute: vi.fn().mockResolvedValue({ executed: true, thresholdUsed: 80 }) };
  const workflows = { begin: vi.fn().mockResolvedValue(receipt) };
  const navigation = { complete: vi.fn(async (_ctx, _launch, presentation) => {
    await presentation.deliver(); events.push('restore');
  }) };
  const handler = new CleanHandler(clean as never, {} as never, workflows as never, navigation as never);
  const commands: Record<string, (ctx: object) => Promise<void>> = {};
  handler.register({ command: vi.fn((name, _guard, fn) => { commands[name] = fn; }), callbackQuery: vi.fn() } as never);
  const ctx = {
    from: { id: 42 }, chat: { id: 42, type: 'private' }, match: '75',
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
    reply: vi.fn(async () => { events.push('result'); }),
  };
  return { handler, commands, clean, workflows, navigation, ctx, events };
}

describe('CleanHandler contextual workflow', () => {
  it('begins a direct Storage cleanup receipt and restores after the result', async () => {
    const { commands, clean, workflows, ctx, events } = setup();

    await commands.clean(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'storage-cleanup', { source: 'natural-parent' });
    expect(clean.execute).toHaveBeenCalledWith(75);
    expect(events).toEqual(['result', 'restore']);
  });

  it('uses a captured launch exactly once for validation failures', async () => {
    const { handler, workflows, ctx, clean, navigation } = setup();
    ctx.match = '101';

    await handler.handleCommand(ctx as never, { receipt } as never);

    expect(workflows.begin).not.toHaveBeenCalled();
    expect(clean.execute).not.toHaveBeenCalled();
    expect(navigation.complete).toHaveBeenCalledOnce();
  });
});
