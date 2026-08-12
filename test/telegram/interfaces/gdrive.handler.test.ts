import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DriveClientDocumentError } from '../../../src/archive/domain/errors/drive-client-document.error';
import { DriveOAuthClientRejectedError } from '../../../src/archive/domain/errors/drive-oauth-client-rejected.error';
import { DrivePolicyBlockedError } from '../../../src/archive/domain/errors/drive-policy-blocked.error';
import { DriveProviderResponseError } from '../../../src/archive/domain/errors/drive-provider-response.error';
import { DriveRateLimitedError } from '../../../src/archive/domain/errors/drive-rate-limited.error';
import { DriveSetupBusyError } from '../../../src/archive/domain/errors/drive-setup-busy.error';
import { DriveSetupExpiredError } from '../../../src/archive/domain/errors/drive-setup-expired.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { catalogFor } from '../../../src/locales';
import { DriveSetupStateRegistry } from '../../../src/telegram/interfaces/drive-setup-state.registry';
import { GdriveHandler } from '../../../src/telegram/interfaces/gdrive.handler';

describe('GdriveHandler status', () => {
  it('never exposes secrets or private links to a group response', async () => {
    const { handler, status } = setupDriveHandler();
    const ctx = {
      from: { id: 7 }, chat: { id: 7, type: 'group' },
      localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } },
      reply: vi.fn(),
    };

    await handler.handleStatus(ctx as never);

    expect(status.execute).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('begins the direct Storage workflow and delivers status before origin restoration', async () => {
    const { handler, ctx, status, workflows, events } = setupDriveHandler({ statusReceipt: true });
    status.execute.mockResolvedValue({
      quota: { usedBytes: 1, totalBytes: 2 }, lastUploadAt: null,
      pendingUploads: 0, failedUploads: 0, lastError: null, cleanupMinAgeDays: 30,
    });

    await handler.handleStatus(ctx as never);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'drive-status', { source: 'natural-parent' });
    expect(events).toEqual(['result', 'restore']);
  });

  it('uses a captured receipt once and restores after a sanitized failure', async () => {
    const { handler, ctx, status, workflows, navigation, events, receipt } = setupDriveHandler({ statusReceipt: true });
    status.execute.mockRejectedValue(new Error('token=https://drive.google.com/private'));

    await handler.handleStatus(ctx as never, {}, { receipt });

    expect(workflows.begin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').gdrive.statusUnavailable);
    expect(navigation.complete).toHaveBeenCalledOnce();
    expect(events).toEqual(['result', 'restore']);
  });
});

describe('GdriveHandler Drive setup entry', () => {
  it.each(['command', 'menu'] as const)('uses the shared guide for %s entry', async (entry) => {
    const { handler, ctx, workflows, states, receipt, begin } = setupDriveHandler();
    const launch = { receipt };

    if (entry === 'command') await handler.handleConnect(ctx as never);
    else await handler.handleConnect(ctx as never, launch);

    expect(workflows.begin).toHaveBeenCalledTimes(entry === 'command' ? 1 : 0);
    if (entry === 'command') {
      expect(workflows.begin).toHaveBeenCalledWith(ctx, 'drive-setup', { source: 'natural-parent' });
    }
    expect(states.prepare).toHaveBeenCalledWith({
      userId: 7,
      chatId: 7,
      receiptId: receipt.id,
      preparationExpiresAtMs: 86_401_000,
    });
    expect(begin.execute).not.toHaveBeenCalled();
    const options = ctx.reply.mock.calls[0][1];
    expect(options.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringMatching(/^https:\/\/console\.cloud\.google\.com\//) }),
      expect.objectContaining({ callback_data: `wr:${receipt.id}:o` }),
    ]));
    expect(JSON.stringify(options)).not.toContain('generation');
  });

  it('removes only the exact preparation when guide delivery fails', async () => {
    const { handler, ctx, states, receipt } = setupDriveHandler();
    ctx.reply.mockRejectedValue(new Error('delivery failed'));

    await expect(handler.handleConnect(ctx as never)).rejects.toThrow('delivery failed');

    expect(states.removePreparation).toHaveBeenCalledWith({ userId: 7, chatId: 7, receiptId: receipt.id });
  });
});

describe('GdriveHandler Drive client documents', () => {
  it.each(['group', 'supergroup', 'channel'])('rejects %s before associating or reading a document', async (type) => {
    const fixture = preparedDocumentFixture();
    const ctx = { ...fixture.ctx, chat: { id: 9, type } };

    await fixture.handler.handleDocument(ctx as never);

    expect(fixture.states.association).not.toHaveBeenCalled();
    expect(fixture.documents.read).not.toHaveBeenCalled();
    expect(fixture.ctx.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('loads the exact receipt before creating and claiming a fresh generation, then exposes exact callbacks', async () => {
    const fixture = preparedDocumentFixture();

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.workflows.loadCurrent).toHaveBeenCalledWith(fixture.ctx, fixture.receipt.id, 'drive-setup');
    expect(fixture.begin.execute).toHaveBeenCalledWith({
      adminUserId: 7, chatId: 7, receiptId: fixture.receipt.id,
    });
    expect(fixture.states.claimAuthorizing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'preparing', receiptId: fixture.receipt.id }),
      fixture.pending,
    );
    expect(fixture.workflows.loadCurrent.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.begin.execute.mock.invocationCallOrder[0]);
    expect(fixture.begin.execute.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.states.claimAuthorizing.mock.invocationCallOrder[0]);
    expect(fixture.states.claimAuthorizing.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.documents.read.mock.invocationCallOrder[0]);
    const submitInput = fixture.submit.execute.mock.calls[0][0];
    expect(submitInput.pending).toBe(fixture.pending);
    expect(submitInput.authorizationSignal).toBe(fixture.controller.signal);
    expect(submitInput.signal).not.toBe(fixture.controller.signal);
    expect(submitInput.signal.aborted).toBe(false);
    expect(submitInput.acceptChallenge({ generationId: fixture.pending.generationId, effectiveDeadlineMs: 121_000 }))
      .toBe(true);
    expect(fixture.states.recordChallenge).toHaveBeenCalledWith({
      kind: 'preparing', userId: 7, chatId: 7, receiptId: fixture.receipt.id,
      preparationExpiresAtMs: 86_401_000,
      generationId: fixture.pending.generationId,
      effectiveDeadlineMs: 121_000,
    });
    const authorizationOptions = fixture.ctx.reply.mock.calls[0][1];
    expect(authorizationOptions.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ callback_data: `gdc:${fixture.receipt.id}:${fixture.pending.generationId}:a` }),
      expect.objectContaining({ callback_data: `gdc:${fixture.receipt.id}:${fixture.pending.generationId}:c` }),
    ]));
    expect(fixture.ctx.api.deleteMessage).toHaveBeenCalledWith(7, 99);
  });

  it('creates a fresh pending generation when the same 24-hour preparation retries after ten minutes', async () => {
    const fixture = preparedDocumentFixture();
    const secondPending = { ...fixture.pending, generationId: 'generation-00002', createdAtMs: 701_000, expiresAtMs: 1_301_000 };
    fixture.begin.execute.mockReturnValueOnce(fixture.pending).mockReturnValueOnce(secondPending);
    fixture.states.claimAuthorizing
      .mockReturnValueOnce(authorizingState(fixture, fixture.pending))
      .mockReturnValueOnce(authorizingState(fixture, secondPending));
    fixture.submit.execute.mockRejectedValue(new DriveTemporaryUnavailableError());

    await fixture.handler.handleDocument(fixture.ctx as never);
    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.begin.execute).toHaveBeenCalledTimes(2);
    expect(fixture.states.returnToPreparing).toHaveBeenNthCalledWith(1, generationIdentity(fixture, fixture.pending));
    expect(fixture.states.returnToPreparing).toHaveBeenNthCalledWith(2, generationIdentity(fixture, secondPending));
  });

  it('rejects a second document when the exact preparation is already authorizing', async () => {
    const fixture = preparedDocumentFixture();
    fixture.states.association.mockReturnValue(authorizingState(fixture));
    fixture.states.claimAuthorizing.mockReturnValue(null);

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.begin.execute).toHaveBeenCalledOnce();
    expect(fixture.documents.read).not.toHaveBeenCalled();
    expect(fixture.submit.execute).not.toHaveBeenCalled();
    expect(fixture.ctx.api.deleteMessage).toHaveBeenCalledWith(7, 99);
  });

  it.each([
    [new DriveClientDocumentError('download-failed'), 'documentInvalid'],
    [new DriveClientDocumentError('too-large'), 'documentInvalid'],
    [new DriveClientDocumentError('invalid-utf8'), 'documentInvalid'],
    [new DriveClientDocumentError('malformed-json'), 'documentInvalid'],
    [new DriveClientDocumentError('invalid-credentials'), 'documentInvalid'],
    [new DriveClientDocumentError('unsupported-client-type'), 'unsupportedClientType'],
    [new DriveOAuthClientRejectedError(), 'clientRejected'],
    [new DriveSetupBusyError(), 'setupBusy'],
    [new DrivePolicyBlockedError(), 'policyBlocked'],
    [new DriveRateLimitedError(), 'rateLimited'],
    [new DriveTemporaryUnavailableError(), 'temporaryUnavailable'],
    [new DriveProviderResponseError(), 'providerResponse'],
  ] as const)('maps %s without provider text and returns only its generation to preparation', async (error, key) => {
    const fixture = preparedDocumentFixture();
    fixture.submit.execute.mockRejectedValue(error);

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.ctx.reply).toHaveBeenCalledWith(fixture.catalog.gdriveConnection[key]);
    expect(fixture.states.returnToPreparing).toHaveBeenCalledWith(generationIdentity(fixture));
    expect(fixture.states.cancelExact).not.toHaveBeenCalled();
    expect(fixture.ctx.api.deleteMessage).toHaveBeenCalledWith(7, 99);
  });

  it('treats initial setup expiry as terminal and restores only the exact current receipt', async () => {
    const fixture = preparedDocumentFixture();
    fixture.submit.execute.mockRejectedValue(new DriveSetupExpiredError());
    fixture.states.takeTerminal.mockReturnValue(authorizingState(fixture));

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.states.returnToPreparing).not.toHaveBeenCalled();
    expect(fixture.states.takeTerminal).toHaveBeenCalledWith(generationIdentity(fixture));
    expect(fixture.states.cancelExact).not.toHaveBeenCalled();
    expect(fixture.navigation.complete).toHaveBeenCalledWith(
      fixture.ctx,
      { receipt: fixture.receipt },
      expect.objectContaining({ effectStage: 'pending', failureNotice: fixture.catalog.home.recovery.unavailable }),
    );
    expect(fixture.ctx.reply).toHaveBeenCalledWith(fixture.catalog.gdriveConnection.setupExpired);
  });

  it.each([
    ['forwarded', { forward_origin: {} }, undefined],
    ['declared oversized', {}, new DriveClientDocumentError('too-large')],
    ['streamed oversized', {}, new DriveClientDocumentError('too-large')],
    ['malformed JSON', {}, new DriveClientDocumentError('malformed-json')],
    ['download failed', {}, new DriveClientDocumentError('download-failed')],
    ['provider failed', {}, new DriveTemporaryUnavailableError()],
  ] as const)('deletes an associated %s credential message', async (_name, extra, error) => {
    const fixture = preparedDocumentFixture();
    Object.assign(fixture.ctx.message, extra);
    if (error instanceof DriveClientDocumentError && error.reason !== 'malformed-json') {
      fixture.documents.read.mockRejectedValue(error);
    } else if (error) {
      fixture.submit.execute.mockRejectedValue(error);
    }

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.ctx.api.deleteMessage).toHaveBeenCalledWith(7, 99);
  });

  it('cancels exact preparation and deletes the document when the snapshotted administrator has lost the role', async () => {
    const fixture = preparedDocumentFixture();
    fixture.ctx.localeState.user.role = 'resident';

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.states.cancelExact).toHaveBeenCalledWith(expect.objectContaining({ receiptId: fixture.receipt.id }));
    expect(fixture.documents.read).not.toHaveBeenCalled();
    expect(fixture.ctx.api.deleteMessage).toHaveBeenCalledWith(7, 99);
  });

  it.each([
    ['wrong user', { from: { id: 8 } }],
    ['wrong chat', { chat: { id: 8, type: 'private' } }],
  ] as const)('does not touch a %s document', async (_name, override) => {
    const fixture = preparedDocumentFixture();
    fixture.states.association.mockReturnValue(null);
    const ctx = { ...fixture.ctx, ...override };

    await fixture.handler.handleDocument(ctx as never);

    expect(fixture.documents.read).not.toHaveBeenCalled();
    expect(fixture.begin.execute).not.toHaveBeenCalled();
    expect(fixture.states.cancelExact).not.toHaveBeenCalled();
    expect(fixture.ctx.api.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.ctx.reply).not.toHaveBeenCalled();
  });

  it('does not emit a stale failure after an associated operation is cancelled', async () => {
    const fixture = preparedDocumentFixture();
    fixture.documents.read.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    fixture.states.association.mockReturnValueOnce(preparingState(fixture)).mockReturnValueOnce(null);
    fixture.states.returnToPreparing.mockReturnValue(false);

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(fixture.ctx.reply).not.toHaveBeenCalled();
    expect(fixture.states.returnToPreparing).toHaveBeenCalledWith(generationIdentity(fixture));
    expect(fixture.ctx.api.deleteMessage).toHaveBeenCalledWith(7, 99);
  });

  it('does not reply from an old generation after a real replacement state is installed', async () => {
    const fixture = realPreparedDocumentFixture();
    const read = deferred<string>();
    fixture.documents.read.mockReturnValue(read.promise);

    const handling = fixture.handler.handleDocument(fixture.ctx as never);
    await vi.waitFor(() => expect(fixture.documents.read).toHaveBeenCalledOnce());
    await fixture.registry.cancelExact(preparingState(fixture));
    fixture.registry.prepare({
      userId: 7, chatId: 7, receiptId: 'ponmlkjihgfedcba', preparationExpiresAtMs: 86_401_000,
    });
    read.reject(new DriveTemporaryUnavailableError());
    await handling;

    expect(fixture.ctx.reply).not.toHaveBeenCalled();
    expect(fixture.registry.association({ userId: 7, chatId: 7 })).toMatchObject({
      kind: 'preparing', receiptId: 'ponmlkjihgfedcba',
    });
  });

  it('does not terminalize a same-receipt retry after an old generation expires', async () => {
    const fixture = realPreparedDocumentFixture();
    const read = deferred<string>();
    fixture.documents.read.mockReturnValue(read.promise);

    const handling = fixture.handler.handleDocument(fixture.ctx as never);
    await vi.waitFor(() => expect(fixture.documents.read).toHaveBeenCalledOnce());
    await fixture.registry.cancelExact(generationIdentity(fixture));
    fixture.registry.prepare({
      userId: 7, chatId: 7, receiptId: fixture.receipt.id, preparationExpiresAtMs: 86_401_000,
    });
    read.reject(new DriveSetupExpiredError());
    await handling;

    expect(fixture.ctx.reply).not.toHaveBeenCalled();
    expect(fixture.registry.association({ userId: 7, chatId: 7 })).toMatchObject({
      kind: 'preparing', receiptId: fixture.receipt.id,
    });
  });

  it('does not reply from a pre-generation failure after its real receipt is replaced', async () => {
    const fixture = realPreparedDocumentFixture();
    const current = deferred<ReturnType<typeof driveSetupReceipt>>();
    fixture.workflows.loadCurrent.mockReturnValueOnce(current.promise);
    fixture.begin.execute.mockImplementation(() => { throw new DriveSetupBusyError(); });

    const handling = fixture.handler.handleDocument(fixture.ctx as never);
    await fixture.registry.cancelExact(preparingState(fixture));
    fixture.registry.prepare({
      userId: 7, chatId: 7, receiptId: 'ponmlkjihgfedcba', preparationExpiresAtMs: 86_401_000,
    });
    current.resolve(fixture.receipt);
    await handling;

    expect(fixture.ctx.reply).not.toHaveBeenCalled();
    expect(fixture.registry.association({ userId: 7, chatId: 7 })?.receiptId).toBe('ponmlkjihgfedcba');
  });

  it('discards the exact staged generation before retrying and leaves another administrator untouched', async () => {
    const order: string[] = [];
    const cancel = {
      execute: vi.fn(async () => { order.push('discard'); return 'cancelled' as const; }),
    };
    const fixture = realPreparedDocumentFixture(cancel);
    fixture.registry.prepare({
      userId: 8, chatId: 8, receiptId: 'bbbbbbbbbbbbbbbb', preparationExpiresAtMs: 86_401_000,
    });
    const returnToPreparing = vi.spyOn(fixture.registry, 'returnToPreparing');
    returnToPreparing.mockImplementation((identity) => {
      order.push('retry');
      returnToPreparing.mockRestore();
      return fixture.registry.returnToPreparing(identity);
    });
    fixture.ctx.reply
      .mockRejectedValueOnce(new Error('authorization delivery failed'))
      .mockResolvedValueOnce({ message_id: 2 });

    await fixture.handler.handleDocument(fixture.ctx as never);

    expect(cancel.execute).toHaveBeenCalledWith({
      generationId: fixture.pending.generationId,
      receiptId: fixture.receipt.id,
      adminUserId: 7,
      chatId: 7,
    });
    expect(order).toEqual(['discard', 'retry']);
    expect(fixture.registry.association({ userId: 7, chatId: 7 })).toMatchObject({
      kind: 'preparing', receiptId: fixture.receipt.id,
    });
    expect(fixture.registry.association({ userId: 8, chatId: 8 })).toMatchObject({
      kind: 'preparing', receiptId: 'bbbbbbbbbbbbbbbb',
    });
  });

  it('warns after deletion failure and swallows warning-delivery failure without provider text', async () => {
    const fixture = preparedDocumentFixture();
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fixture.ctx.api.deleteMessage.mockRejectedValue(new Error('delete private-path'));
    fixture.ctx.reply
      .mockResolvedValueOnce({ message_id: 1 })
      .mockRejectedValueOnce(new Error('reply private-path'));

    await expect(fixture.handler.handleDocument(fixture.ctx as never)).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledWith('Drive credential message deletion warning delivery failed');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-path');
    warning.mockRestore();
  });
});

describe('GdriveHandler Drive authorization callbacks', () => {
  it('ignores an exact authorization callback until a challenge deadline is recorded', async () => {
    const fixture = authorizationFixture();
    fixture.state.effectiveDeadlineMs = null;
    fixture.states.authorizing.mockReturnValue(fixture.state);

    await fixture.invoke('a');

    expect(fixture.confirm.execute).not.toHaveBeenCalled();
    expect(fixture.ctx.reply).not.toHaveBeenCalled();
  });

  it('confirms only the exact current generation with its effective deadline and shared cancellation signal', async () => {
    const fixture = authorizationFixture();
    fixture.confirm.execute.mockResolvedValue('pending');

    await fixture.invoke('a');

    expect(fixture.states.authorizing).toHaveBeenCalledWith(generationIdentity(fixture));
    expect(fixture.workflows.loadCurrent).toHaveBeenCalledWith(fixture.ctx, fixture.receipt.id, 'drive-setup');
    expect(fixture.confirm.execute).toHaveBeenCalledWith({
      generationId: fixture.pending.generationId,
      receiptId: fixture.receipt.id,
      adminUserId: 7,
      chatId: 7,
      effectiveDeadlineMs: 121_000,
      signal: expect.objectContaining({ aborted: false }),
    });
    expect(fixture.ctx.reply).toHaveBeenCalledWith(fixture.catalog.gdriveConnection.authorizationPending);
    expect(fixture.states.takeActivated).not.toHaveBeenCalled();
  });

  it('does not send pending after concurrent cancellation installs a replacement state', async () => {
    const pending = deferred<'pending'>();
    const fixture = realAuthorizationFixture();
    fixture.confirm.execute.mockReturnValue(pending.promise);

    const handling = fixture.invoke('a');
    await vi.waitFor(() => expect(fixture.confirm.execute).toHaveBeenCalledOnce());
    await fixture.registry.cancelExact(generationIdentity(fixture));
    fixture.registry.prepare({
      userId: 7, chatId: 7, receiptId: 'ponmlkjihgfedcba', preparationExpiresAtMs: 86_401_000,
    });
    pending.resolve('pending');
    await handling;

    expect(fixture.ctx.reply).not.toHaveBeenCalled();
    expect(fixture.registry.association({ userId: 7, chatId: 7 })?.receiptId).toBe('ponmlkjihgfedcba');
  });

  it('does not send pending when the exact workflow receipt stops being current during confirmation', async () => {
    const pending = deferred<'pending'>();
    const fixture = realAuthorizationFixture();
    fixture.confirm.execute.mockReturnValue(pending.promise);
    fixture.workflows.loadCurrent
      .mockResolvedValueOnce(fixture.receipt)
      .mockResolvedValueOnce(null);

    const handling = fixture.invoke('a');
    await vi.waitFor(() => expect(fixture.confirm.execute).toHaveBeenCalledOnce());
    pending.resolve('pending');
    await handling;

    expect(fixture.ctx.reply).not.toHaveBeenCalled();
    expect(fixture.registry.authorizing(generationIdentity(fixture))).not.toBeNull();
  });

  it('removes the activated exact generation before terminal delivery and restoration', async () => {
    const fixture = authorizationFixture();
    fixture.confirm.execute.mockResolvedValue('activated');
    fixture.states.takeActivated.mockImplementation(() => {
      fixture.events.push('take');
      return fixture.state;
    });

    await fixture.invoke('a');

    expect(fixture.events).toEqual(['take', 'result', 'restore']);
    expect(fixture.navigation.complete).toHaveBeenCalledWith(
      fixture.ctx,
      { receipt: fixture.receipt },
      expect.objectContaining({ effectStage: 'pending', failureNotice: fixture.catalog.home.recovery.unavailable }),
    );
    expect(fixture.ctx.reply).toHaveBeenCalledWith(fixture.catalog.gdriveConnection.connected);
  });

  it.each([
    [new DriveSetupExpiredError(), 'setupExpired'],
    [new DrivePolicyBlockedError(), 'policyBlocked'],
    [new DriveRateLimitedError(), 'rateLimited'],
    [new DriveProviderResponseError(), 'providerResponse'],
    [new DriveTemporaryUnavailableError(), 'temporaryUnavailable'],
    [new Error('provider secret'), 'temporaryUnavailable'],
  ] as const)('terminalizes exact confirmation failure %s and completes only its receipt', async (error, key) => {
    const fixture = authorizationFixture();
    fixture.confirm.execute.mockRejectedValue(error);
    fixture.states.takeTerminal.mockReturnValue(fixture.state);

    await fixture.invoke('a');

    expect(fixture.states.takeTerminal).toHaveBeenCalledWith(generationIdentity(fixture));
    expect(fixture.states.returnToPreparing).not.toHaveBeenCalled();
    expect(fixture.navigation.complete).toHaveBeenCalledOnce();
    expect(fixture.ctx.reply).toHaveBeenCalledWith(fixture.catalog.gdriveConnection[key]);
    expect(JSON.stringify(fixture.ctx.reply.mock.calls)).not.toContain('provider secret');
  });

  it('does not complete a confirmation failure already superseded in registry state', async () => {
    const fixture = authorizationFixture();
    fixture.confirm.execute.mockRejectedValue(new DriveTemporaryUnavailableError());
    fixture.states.takeTerminal.mockReturnValue(null);

    await fixture.invoke('a');

    expect(fixture.navigation.complete).not.toHaveBeenCalled();
    expect(fixture.ctx.reply).not.toHaveBeenCalled();
  });

  it('cancels only the exact generation for a generation-bearing cancel callback', async () => {
    const fixture = authorizationFixture();
    fixture.states.cancelExact.mockResolvedValue('cancelled');

    await fixture.invoke('c');

    expect(fixture.states.cancelExact).toHaveBeenCalledWith(fixture.state);
    expect(fixture.confirm.execute).not.toHaveBeenCalled();
  });

  it('ignores a stale or wrong-user generation callback without mutation or reply', async () => {
    const fixture = authorizationFixture();
    fixture.states.authorizing.mockReturnValue(null);

    await fixture.invoke('a');

    expect(fixture.confirm.execute).not.toHaveBeenCalled();
    expect(fixture.states.cancelExact).not.toHaveBeenCalled();
    expect(fixture.ctx.reply).not.toHaveBeenCalled();
  });
});

function driveSetupReceipt(workflow: 'drive-setup' | 'drive-status' = 'drive-setup') {
  return {
    id: 'abcdefghijklmnop', userId: 7, chatId: 7, kind: 'workflow-return' as const,
    sessionToken: null, status: 'pending' as const, expiresAt: new Date(86_401_000),
    payload: {
      workflow, phase: 'cancellable' as const,
      originSource: 'natural-parent' as const, origin: { kind: 'admin-storage' as const },
    },
  };
}

function setupDriveHandler(options: {
  statusReceipt?: boolean;
  setupStates?: DriveSetupStateRegistry;
  cancel?: { execute: ReturnType<typeof vi.fn> };
} = {}) {
  const events: string[] = [];
  const receipt = driveSetupReceipt(options.statusReceipt ? 'drive-status' : 'drive-setup');
  const status = { execute: vi.fn() };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    loadCurrent: vi.fn().mockResolvedValue(receipt),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
      events.push('restore');
    }),
  };
  const states = {
    prepare: vi.fn(), removePreparation: vi.fn(), association: vi.fn(),
    authorizing: vi.fn(), claimAuthorizing: vi.fn(), recordChallenge: vi.fn(),
    returnToPreparing: vi.fn().mockReturnValue(true),
    observeAuthorized: vi.fn(), takeTerminal: vi.fn(), takeActivated: vi.fn(),
    cancelExact: vi.fn().mockResolvedValue('cancelled'), cancelUser: vi.fn(),
  };
  const ctx = {
    from: { id: 7 }, chat: { id: 7, type: 'private' },
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } },
    reply: vi.fn(async () => { events.push('result'); return { message_id: 1 }; }),
  };
  const documents = { read: vi.fn() };
  const begin = { execute: vi.fn() };
  const submit = { execute: vi.fn() };
  const confirm = { execute: vi.fn() };
  const cancel = options.cancel ?? { execute: vi.fn().mockResolvedValue('cancelled') };
  const handler = new GdriveHandler(
    status as never,
    {} as never,
    workflows as never,
    navigation as never,
    documents,
    begin as never,
    submit as never,
    confirm as never,
    cancel as never,
    { activeGeneration: vi.fn() } as never,
    (options.setupStates ?? states) as never,
  );
  return {
    handler, ctx, status, workflows, navigation, states, receipt, documents, begin, submit, confirm, cancel, events,
  };
}

function preparedDocumentFixture() {
  const fixture = setupDriveHandler();
  const pending = {
    generationId: 'generation-00001', receiptId: fixture.receipt.id,
    adminUserId: 7, chatId: 7, installationId: 'installation-1',
    createdAtMs: 1_000, expiresAtMs: 601_000,
  };
  const controller = new AbortController();
  Object.assign(fixture.ctx, {
    message: { message_id: 99, document: { file_id: 'file-1', file_size: 200 } },
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  });
  fixture.states.association.mockReturnValue(preparingState({ ...fixture, pending, controller }));
  fixture.states.claimAuthorizing.mockReturnValue(authorizingState({ ...fixture, pending, controller }));
  fixture.states.recordChallenge.mockReturnValue(true);
  fixture.begin.execute.mockReturnValue(pending);
  fixture.documents.read.mockResolvedValue(JSON.stringify({ installed: {
    client_id: '123-device.apps.googleusercontent.com', client_secret: 'secret_12345678',
  } }));
  fixture.submit.execute.mockResolvedValue({
    verificationUri: 'https://www.google.com/device', userCode: 'Ab9-Xy2',
    effectiveDeadlineMs: 121_000,
  });
  return { ...fixture, pending, controller, catalog: catalogFor('en') };
}

function realPreparedDocumentFixture(
  cancel = { execute: vi.fn().mockResolvedValue('cancelled') },
) {
  const registry = new DriveSetupStateRegistry(
    { now: () => new Date(1_000) },
    cancel as never,
    { register: vi.fn() } as never,
  );
  const fixture = setupDriveHandler({ setupStates: registry, cancel });
  const pending: PendingFixture = {
    generationId: 'generation-00001', receiptId: fixture.receipt.id,
    adminUserId: 7, chatId: 7, installationId: 'installation-1',
    createdAtMs: 1_000, expiresAtMs: 601_000,
  };
  registry.prepare(preparingState({ ...fixture, pending }));
  Object.assign(fixture.ctx, {
    message: { message_id: 99, document: { file_id: 'file-1', file_size: 200 } },
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  });
  fixture.begin.execute.mockReturnValue(pending);
  fixture.documents.read.mockResolvedValue(JSON.stringify({ installed: {
    client_id: '123-device.apps.googleusercontent.com', client_secret: 'secret_12345678',
  } }));
  fixture.submit.execute.mockResolvedValue({
    verificationUri: 'https://www.google.com/device', userCode: 'Ab9-Xy2',
    effectiveDeadlineMs: 121_000,
  });
  return { ...fixture, registry, pending, catalog: catalogFor('en') };
}

function authorizationFixture() {
  const fixture = preparedDocumentFixture();
  const state = authorizingState(fixture);
  state.effectiveDeadlineMs = 121_000;
  fixture.states.authorizing.mockReturnValue(state);
  fixture.states.takeActivated.mockReturnValue(state);
  const callbacks: { fn: (ctx: object) => Promise<void> }[] = [];
  fixture.handler.register({
    command: vi.fn(), on: vi.fn(),
    callbackQuery: vi.fn((_pattern, fn) => { callbacks.push({ fn }); }),
  } as never);
  fixture.ctx.reply.mockClear();
  fixture.events.length = 0;
  return {
    ...fixture,
    state,
    invoke: async (action: 'a' | 'c') => {
      Object.assign(fixture.ctx, {
        callbackQuery: { data: `gdc:${fixture.receipt.id}:${fixture.pending.generationId}:${action}` },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await callbacks[0].fn(fixture.ctx);
    },
  };
}

function realAuthorizationFixture() {
  const fixture = realPreparedDocumentFixture();
  const state = fixture.registry.claimAuthorizing(preparingState(fixture), fixture.pending)!;
  fixture.registry.recordChallenge({ ...generationIdentity(fixture), effectiveDeadlineMs: 121_000 });
  const callbacks: { fn: (ctx: object) => Promise<void> }[] = [];
  fixture.handler.register({
    command: vi.fn(), on: vi.fn(),
    callbackQuery: vi.fn((_pattern, fn) => { callbacks.push({ fn }); }),
  } as never);
  fixture.ctx.reply.mockClear();
  fixture.events.length = 0;
  return {
    ...fixture,
    state,
    invoke: async (action: 'a' | 'c') => {
      Object.assign(fixture.ctx, {
        callbackQuery: { data: `gdc:${fixture.receipt.id}:${fixture.pending.generationId}:${action}` },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });
      await callbacks[0].fn(fixture.ctx);
    },
  };
}

function preparingState(fixture: { receipt: ReturnType<typeof driveSetupReceipt> }) {
  return {
    kind: 'preparing' as const, userId: 7, chatId: 7, receiptId: fixture.receipt.id,
    preparationExpiresAtMs: fixture.receipt.expiresAt.getTime(),
  };
}

function authorizingState(
  fixture: { receipt: ReturnType<typeof driveSetupReceipt>; pending: PendingFixture; controller: AbortController },
  pending = fixture.pending,
) {
  return {
    kind: 'authorizing' as const, ...preparingState(fixture), pending,
    effectiveDeadlineMs: null as number | null, controller: fixture.controller,
  };
}

function generationIdentity(
  fixture: { receipt: ReturnType<typeof driveSetupReceipt>; pending: PendingFixture },
  pending = fixture.pending,
) {
  return { userId: 7, chatId: 7, receiptId: fixture.receipt.id, generationId: pending.generationId };
}

interface PendingFixture {
  generationId: string;
  receiptId: string;
  adminUserId: number;
  chatId: number;
  installationId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
