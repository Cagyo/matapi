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
  handler.register({
    command: vi.fn((name, _guard, fn) => { commands[name] = fn; }),
    on: vi.fn(),
    callbackQuery: vi.fn(),
  } as never);
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

describe('GdriveHandler Drive client uploads', () => {
  it.each(['group', 'supergroup', 'channel'])('rejects %s before reading a document', async (type) => {
    const { GdriveHandler: DriveSetupHandler } = await import('../../../src/telegram/interfaces/gdrive.handler');
    const documentReader = { read: vi.fn() };
    const handler = new DriveSetupHandler(
      {} as never,
      {} as never,
      {} as never,
      undefined,
      documentReader as never,
    );
    const ctx = {
      from: { id: 7 },
      chat: { id: 9, type },
      message: { document: { file_id: 'file-1', file_size: 20 } },
      localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } },
      reply: vi.fn(),
    };

    await handler.handleDocument(ctx as never);

    expect(documentReader.read).not.toHaveBeenCalled();
  });

  it('deletes a read credential document when validation fails and warns only if deletion fails', async () => {
    const documents = { read: vi.fn().mockResolvedValue('{"installed":{}}') };
    const submit = { execute: vi.fn().mockRejectedValue(new Error('invalid')) };
    const begin = { execute: vi.fn().mockReturnValue({
      generationId: 'generation-00001', receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
      installationId: 'installation-1', createdAtMs: 1, expiresAtMs: 2,
    }) };
    const handler = new GdriveHandler({} as never, {} as never, {} as never, undefined, documents as never, begin as never, submit as never);
    const ctx = {
      from: { id: 7 }, chat: { id: 9, type: 'private' },
      message: { message_id: 3, document: { file_id: 'file-1', file_size: 20 } },
      localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } },
      reply: vi.fn(), api: { deleteMessage: vi.fn().mockRejectedValue(new Error('forbidden')) },
    };

    await handler.handleConnect(ctx as never);
    await handler.handleDocument(ctx as never);

    expect(documents.read).toHaveBeenCalledOnce();
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(9, 3);
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').gdriveConnection.manualDelete);
  });

  it('rejects forwarded credential documents before reading them', async () => {
    const documents = { read: vi.fn() };
    const handler = new GdriveHandler({} as never, {} as never, {} as never, undefined, documents as never);
    const ctx = {
      from: { id: 7 }, chat: { id: 9, type: 'private' },
      message: { forward_origin: {}, document: { file_id: 'file-1', file_size: 20 } },
      localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } }, reply: vi.fn(),
    };

    await handler.handleDocument(ctx as never);

    expect(documents.read).not.toHaveBeenCalled();
  });

  it('cancels the previous staged connection before starting a replacement', async () => {
    const begin = { execute: vi.fn()
      .mockReturnValueOnce({ generationId: 'generation-00001', receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9, installationId: 'installation-1', createdAtMs: 1, expiresAtMs: 2 })
      .mockReturnValueOnce({ generationId: 'generation-00002', receiptId: 'ponmlkjihgfedcba', adminUserId: 7, chatId: 9, installationId: 'installation-1', createdAtMs: 3, expiresAtMs: 4 }) };
    const cancel = { execute: vi.fn().mockResolvedValue('cancelled') };
    const handler = new GdriveHandler({} as never, {} as never, {} as never, undefined, {} as never, begin as never, {} as never, {} as never, cancel as never, {} as never);
    const ctx = {
      from: { id: 7 }, chat: { id: 9, type: 'private' },
      localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } }, reply: vi.fn(),
    };

    await handler.handleConnect(ctx as never);
    await handler.handleConnect(ctx as never);

    expect(cancel.execute).toHaveBeenCalledWith({ generationId: 'generation-00001', receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9 });
  });
});
