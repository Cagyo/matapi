import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { ImportConfigHandler } from '../../../src/telegram/interfaces/import-config.handler';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'sensor-import', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-sensor-setup' } },
};
const sensorPlan = { batch: { inserts: [], updates: [], archives: [] }, summary: { added: ['door'], updated: [], archived: [] } };
const cameraPlan = { sources: [], configured: [] };

function setup() {
  const imports = { prepare: vi.fn(), commit: vi.fn().mockResolvedValue(sensorPlan.summary) };
  const cameraImports = { prepare: vi.fn(), commit: vi.fn().mockResolvedValue(cameraPlan.configured) };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const drafts = new WorkflowDraftRegistry();
  const handler = new ImportConfigHandler(
    imports as never,
    cameraImports as never,
    { parse: vi.fn() } as never,
    {} as never,
    { findByTelegramId: vi.fn().mockResolvedValue({ role: 'admin' }) } as never,
    workflows as never,
    drafts,
  );
  const ctx = {
    from: { id: 42 }, chat: { id: 42, type: 'private' },
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
  return { handler, imports, cameraImports, workflows, drafts, ctx };
}

function seedConfirm(handler: ImportConfigHandler) {
  (handler as unknown as { states: Map<string, unknown> }).states.set('42:42', {
    userId: 42, chatId: 42, receiptId: receipt.id, receipt,
    kind: 'awaitingConfirm', sensorPlan, cameraPlan,
  });
}

describe('ImportConfigHandler contextual workflow', () => {
  it('begins the direct Sensor setup workflow and binds every wizard control to its receipt', async () => {
    const { handler, workflows, ctx } = setup();

    await handler.handleCommand(ctx as never);

    const callbacks = ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard.flat()
      .map((button: { callback_data?: string }) => button.callback_data);
    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'sensor-import', { source: 'natural-parent' });
    expect(callbacks).toEqual(expect.arrayContaining([
      `imp:${receipt.id}:c`, `wr:${receipt.id}:h`,
    ]));
  });

  it('rejects a stale receipt callback before deleting state, markup, or invoking imports', async () => {
    const { handler, imports, cameraImports, ctx } = setup();
    seedConfirm(handler);
    ctx.callbackQuery = { data: 'imp:qrstuvwxyzabcdef:a' };

    await (handler as unknown as { onCallback(context: object): Promise<void> }).onCallback(ctx);

    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(imports.commit).not.toHaveBeenCalled();
    expect(cameraImports.commit).not.toHaveBeenCalled();
    expect((handler as unknown as { states: Map<string, unknown> }).states.has('42:42')).toBe(true);
  });

  it('claims the exact Apply callback once before starting either import transaction', async () => {
    const { handler, imports, cameraImports, ctx } = setup();
    seedConfirm(handler);
    ctx.callbackQuery = { data: `imp:${receipt.id}:a` };

    await (handler as unknown as { onCallback(context: object): Promise<void> }).onCallback(ctx);
    await (handler as unknown as { onCallback(context: object): Promise<void> }).onCallback(ctx);

    expect(cameraImports.commit).not.toHaveBeenCalled();
    expect(imports.commit).toHaveBeenCalledOnce();
  });

  it('marks the import receipt running before committing camera or sensor changes', async () => {
    const { handler, imports, cameraImports, workflows, ctx } = setup();
    const events: string[] = [];
    (handler as unknown as { states: Map<string, unknown> }).states.set('42:42', {
      userId: 42,
      chatId: 42,
      receiptId: receipt.id,
      receipt,
      kind: 'awaitingConfirm',
      sensorPlan,
      cameraPlan: { sources: [], configured: ['front-door'] },
    });
    ctx.callbackQuery = { data: `imp:${receipt.id}:a` };
    workflows.markRunning.mockImplementation(async () => {
      events.push('mark-running');
      return true;
    });
    cameraImports.commit.mockImplementation(async () => {
      events.push('camera-commit');
      return ['front-door'];
    });
    imports.commit.mockImplementation(async () => {
      events.push('sensor-commit');
      return sensorPlan.summary;
    });

    await (handler as unknown as { onCallback(context: object): Promise<void> }).onCallback(ctx);

    expect(events).toEqual(['mark-running', 'camera-commit', 'sensor-commit']);
  });

  it('lets /cancel continue unless this handler owns the exact private receipt', async () => {
    const { handler, ctx } = setup();
    const commands: Record<string, (context: object, next: () => Promise<void>) => Promise<void>> = {};
    handler.register({ command: vi.fn((name, _guard, fn) => { commands[name] = fn; }), callbackQuery: vi.fn(), on: vi.fn() } as never);
    const next = vi.fn().mockResolvedValue(undefined);

    await commands.cancel(ctx, next);
    expect(next).toHaveBeenCalledOnce();

    await handler.handleCommand(ctx as never);
    await commands.cancel(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect((handler as unknown as { states: Map<string, unknown> }).states.has('42:42')).toBe(false);
  });
});
