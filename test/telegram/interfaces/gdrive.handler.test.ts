import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { GdriveNotConfiguredError } from '../../../src/camera/domain/errors/gdrive-not-configured.error';
import { GdriveHandler } from '../../../src/telegram/interfaces/gdrive.handler';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'drive-status', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-storage' } },
};

function setup() {
  const events: string[] = [];
  const status = { execute: vi.fn() };
  const workflows = { begin: vi.fn(async () => receipt) };
  const navigation = { complete: vi.fn(async (_ctx, _launch, presentation) => {
    await presentation.deliver();
    events.push('restore');
  }) };
  const handler = new GdriveHandler(status as never, {} as never, workflows as never, navigation as never);
  const commands: Record<string, (ctx: object) => Promise<void>> = {};
  handler.register({ command: vi.fn((name, _guard, fn) => { commands[name] = fn; }) } as never);
  const ctx = {
    from: { id: 42 }, chat: { id: 42, type: 'private' }, match: 'status',
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
    reply: vi.fn(async () => { events.push('result'); }),
  };
  return { handler, commands, ctx, status, workflows, navigation, events };
}

describe('GdriveHandler', () => {
  it('begins the direct Storage workflow and delivers status before origin restoration', async () => {
    const { commands, ctx, status, workflows, events } = setup();
    status.execute.mockResolvedValue({
      quota: { usedBytes: 1, totalBytes: 2 }, lastUploadAt: null,
      pendingUploads: 0, failedUploads: 0, lastError: null, cleanupMinAgeDays: 30,
    });

    await commands.gdrive(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'drive-status', { source: 'natural-parent' });
    expect(events).toEqual(['result', 'restore']);
  });

  it('uses a captured receipt once and restores after a typed failure', async () => {
    const { handler, ctx, status, workflows, navigation, events } = setup();
    status.execute.mockRejectedValue(new GdriveNotConfiguredError());

    await handler.handleStatus(ctx as never, {}, { receipt } as never);

    expect(workflows.begin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').gdrive.notConfigured);
    expect(navigation.complete).toHaveBeenCalledOnce();
    expect(events).toEqual(['result', 'restore']);
  });
});
