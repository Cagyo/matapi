import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DriveAuthorizationPollingService } from '../../../src/archive/application/drive-authorization-polling.service';
import { DisconnectDriveUseCase } from '../../../src/archive/application/use-cases/disconnect-drive.use-case';
import { ConfirmDriveAccountUseCase } from '../../../src/archive/application/use-cases/confirm-drive-account.use-case';
import { CancelDriveConnectionUseCase } from '../../../src/archive/application/use-cases/cancel-drive-connection.use-case';
import { DriveAuthorizationDeniedError } from '../../../src/archive/domain/errors/drive-authorization-denied.error';
import { DriveOAuthClientRejectedError } from '../../../src/archive/domain/errors/drive-oauth-client-rejected.error';
import { DrivePolicyBlockedError } from '../../../src/archive/domain/errors/drive-policy-blocked.error';
import { DriveProviderResponseError } from '../../../src/archive/domain/errors/drive-provider-response.error';
import { DriveRateLimitedError } from '../../../src/archive/domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../../../src/archive/domain/errors/drive-reauthorization-required.error';
import { DriveSetupExpiredError } from '../../../src/archive/domain/errors/drive-setup-expired.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { InMemoryDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-credential.repository';

describe('Drive connection workflow', () => {
  it('does not activate a staged account before the device poll stores tokens', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await credentials.stage({
      id: 'pending-generation', installationId: 'installation-1', client: { clientId: 'pending.apps.googleusercontent.com', clientSecret: 'pending-secret' },
      clientIdHash: 'pending', adminUserId: 7, chatId: 9, receiptId: 'pending-receipt', createdAtMs: 1, expiresAtMs: 2,
    });
    const accounts = { resolveAccount: vi.fn(), resolveManagedFolders: vi.fn() };
    const workflow = new ConfirmDriveAccountUseCase(credentials, accounts as never, { now: () => new Date(3) });

    await expect(workflow.execute({ generationId: 'pending-generation', receiptId: 'pending-receipt', adminUserId: 7, chatId: 9, effectiveDeadlineMs: 4, signal: new AbortController().signal }))
      .resolves.toBe('pending');

    expect(accounts.resolveAccount).not.toHaveBeenCalled();
    expect(await credentials.loadStaged('pending-receipt')).not.toBeNull();
    expect(await credentials.loadActive()).toBeNull();
  });

  it('preserves the active generation when account confirmation is rejected', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await credentials.stage({
      id: 'old-generation', installationId: 'installation-1', client: { clientId: 'old.apps.googleusercontent.com', clientSecret: 'old-secret' },
      clientIdHash: 'old', adminUserId: 1, chatId: 1, receiptId: 'old-receipt', createdAtMs: 1, expiresAtMs: 2,
    });
    await credentials.storeExchangedTokens('old-generation', 0, { accessToken: null, refreshToken: 'old-refresh', expiryDateMs: null, tokenType: null, scope: null });
    await credentials.activate({
      stagedId: 'old-generation', expectedRevision: 1, permissionId: 'old-permission', email: null, displayName: null,
      folders: { rootId: 'old-root', motionId: 'old-motion', backupsId: 'old-backups' }, activatedAtMs: 3,
    });
    await credentials.stage({
      id: 'new-generation', installationId: 'installation-1', client: { clientId: 'new.apps.googleusercontent.com', clientSecret: 'new-secret' },
      clientIdHash: 'new', adminUserId: 7, chatId: 9, receiptId: 'receipt-1', createdAtMs: 4, expiresAtMs: 5,
    });

    const workflow = new ConfirmDriveAccountUseCase(credentials, {} as never, { now: () => new Date(6) });
    await workflow.rejectAccount({ receiptId: 'receipt-1', adminUserId: 7, chatId: 9 });

    expect((await credentials.loadActive())?.id).toBe('old-generation');
    expect(await credentials.loadStaged('receipt-1')).toBeNull();
  });

  it('discards the exact staged generation when confirmation reaches its effective deadline', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await credentials.stage({
      id: 'old-generation', installationId: 'installation-1', client: { clientId: 'old.apps.googleusercontent.com', clientSecret: 'old-secret' },
      clientIdHash: 'old', adminUserId: 1, chatId: 1, receiptId: 'old-receipt', createdAtMs: 1, expiresAtMs: 99,
    });
    await credentials.storeExchangedTokens('old-generation', 0, { accessToken: null, refreshToken: 'old-refresh', expiryDateMs: null, tokenType: null, scope: null });
    await credentials.activate({
      stagedId: 'old-generation', expectedRevision: 1, permissionId: 'old-permission', email: null, displayName: null,
      folders: { rootId: 'old-root', motionId: 'old-motion', backupsId: 'old-backups' }, activatedAtMs: 3,
    });
    await credentials.stage({
      id: 'new-generation', installationId: 'installation-1', client: { clientId: 'new.apps.googleusercontent.com', clientSecret: 'new-secret' },
      clientIdHash: 'new', adminUserId: 7, chatId: 9, receiptId: 'receipt-1', createdAtMs: 4, expiresAtMs: 99,
    });
    await credentials.storeExchangedTokens('new-generation', 0, { accessToken: null, refreshToken: 'new-refresh', expiryDateMs: null, tokenType: null, scope: null });
    const workflow = new ConfirmDriveAccountUseCase(credentials, {
      resolveAccount: vi.fn().mockResolvedValue({ permissionId: 'new-permission', email: null, displayName: null }),
      resolveManagedFolders: vi.fn().mockResolvedValue({ rootId: 'new-root', motionId: 'new-motion', backupsId: 'new-backups' }),
    } as never, { now: () => new Date(10) });

    await expect(workflow.execute({
      generationId: 'new-generation', receiptId: 'receipt-1', adminUserId: 7, chatId: 9,
      effectiveDeadlineMs: 10, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DriveSetupExpiredError);

    expect((await credentials.loadActive())?.id).toBe('old-generation');
    expect(await credentials.loadStaged('receipt-1')).toBeNull();
  });

  it('rejects confirmation when the final activation timestamp reaches the deadline', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await credentials.stage({
      id: 'generation-00001', installationId: 'installation-1', client: { clientId: 'new.apps.googleusercontent.com', clientSecret: 'new-secret' },
      clientIdHash: 'new', adminUserId: 7, chatId: 9, receiptId: 'receipt-1', createdAtMs: 4, expiresAtMs: 99,
    });
    await credentials.storeExchangedTokens('generation-00001', 0, { accessToken: null, refreshToken: 'new-refresh', expiryDateMs: null, tokenType: null, scope: null });
    const readings = [9, 9, 10];
    const workflow = new ConfirmDriveAccountUseCase(credentials, {
      resolveAccount: vi.fn().mockResolvedValue({ permissionId: 'new-permission', email: null, displayName: null }),
      resolveManagedFolders: vi.fn().mockResolvedValue({ rootId: 'new-root', motionId: 'new-motion', backupsId: 'new-backups' }),
    } as never, { now: () => new Date(readings.shift() ?? 10) });

    await expect(workflow.execute({
      generationId: 'generation-00001', receiptId: 'receipt-1', adminUserId: 7, chatId: 9,
      effectiveDeadlineMs: 10, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DriveSetupExpiredError);

    expect(await credentials.loadStaged('receipt-1')).toBeNull();
  });

  it('rejects confirmation when account resolution crosses the effective deadline', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await credentials.stage({
      id: 'generation-00001', installationId: 'installation-1', client: { clientId: 'new.apps.googleusercontent.com', clientSecret: 'new-secret' },
      clientIdHash: 'new', adminUserId: 7, chatId: 9, receiptId: 'receipt-1', createdAtMs: 4, expiresAtMs: 99,
    });
    await credentials.storeExchangedTokens('generation-00001', 0, { accessToken: null, refreshToken: 'new-refresh', expiryDateMs: null, tokenType: null, scope: null });
    let nowMs = 9;
    const workflow = new ConfirmDriveAccountUseCase(credentials, {
      resolveAccount: vi.fn().mockImplementation(async () => { nowMs = 10; return { permissionId: 'new-permission', email: null, displayName: null }; }),
      resolveManagedFolders: vi.fn().mockResolvedValue({ rootId: 'new-root', motionId: 'new-motion', backupsId: 'new-backups' }),
    } as never, { now: () => new Date(nowMs) });

    await expect(workflow.execute({
      generationId: 'generation-00001', receiptId: 'receipt-1', adminUserId: 7, chatId: 9,
      effectiveDeadlineMs: 10, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DriveSetupExpiredError);

    expect(await credentials.loadStaged('receipt-1')).toBeNull();
  });
});

describe('background authorization and disconnect', () => {
  it.each([
    [new DriveAuthorizationDeniedError(), 'denied'],
    [new DriveReauthorizationRequiredError(), 'expired'],
    [new DrivePolicyBlockedError(), 'policy'],
    [new DriveRateLimitedError(), 'rate-limited'],
    [new DriveOAuthClientRejectedError(), 'client-rejected'],
    [new DriveProviderResponseError(), 'provider-response'],
    [new DriveTemporaryUnavailableError(), 'unavailable'],
  ] as const)('publishes the closed background reason for %s', async (error, reason) => {
    const credentials = {
      storeExchangedTokens: vi.fn(),
      discardStaged: vi.fn().mockResolvedValue(undefined),
      expireStaged: vi.fn(),
      loadStaged: vi.fn(),
    };
    const outcomes = { publish: vi.fn().mockResolvedValue(undefined) };
    const polling = new DriveAuthorizationPollingService(
      { poll: vi.fn().mockRejectedValue(error) } as never,
      credentials,
      { resolveAccount: vi.fn() },
      outcomes,
    );

    polling.start({
      generationId: 'generation-00001', expectedRevision: 0,
      receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
      client: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret-123' },
      signal: new AbortController().signal,
      challenge: { deviceCode: 'device', userCode: 'user', verificationUri: 'https://example.test', verificationUriComplete: null, intervalMs: 1, expiresAtMs: 99 },
    });

    await vi.waitFor(() => expect(outcomes.publish).toHaveBeenCalledWith({
      kind: 'failed', generationId: 'generation-00001', receiptId: 'abcdefghijklmnop',
      adminUserId: 7, chatId: 9, reason,
    }));
    expect(credentials.discardStaged).toHaveBeenCalledWith('generation-00001', 'abcdefghijklmnop');
    expect(credentials.discardStaged.mock.invocationCallOrder[0])
      .toBeLessThan(outcomes.publish.mock.invocationCallOrder[0]);
  });

  it('aborts polling before loading staged credentials for cancellation', async () => {
    const order: string[] = [];
    const polling = { cancel: vi.fn(() => order.push('cancel')) };
    const credentials = {
      loadStaged: vi.fn(async () => { order.push('load'); throw new Error('db unavailable'); }),
      discardStaged: vi.fn(),
    };
    const useCase = new CancelDriveConnectionUseCase(credentials, polling as never);

    await expect(useCase.execute({
      generationId: 'generation-00001', receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 7,
    })).rejects.toThrow('db unavailable');

    expect(order).toEqual(['cancel', 'load']);
  });

  it('publishes the approved account identity only after it persists exchanged tokens', async () => {
    const credentials = {
      storeExchangedTokens: vi.fn().mockResolvedValue(true), discardStaged: vi.fn(), expireStaged: vi.fn(),
      loadStaged: vi.fn().mockResolvedValue({ id: 'generation-00001' }),
    };
    const publish = vi.fn().mockResolvedValue(undefined);
    const polling = new DriveAuthorizationPollingService(
      { poll: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', expiryDateMs: null, tokenType: null, scope: null }) } as never,
      credentials,
      { resolveAccount: vi.fn().mockResolvedValue({ permissionId: 'permission-1', email: null, displayName: 'Drive admin' }) },
      { publish },
    );

    polling.start({ generationId: 'generation-00001', expectedRevision: 0, receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
      client: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret-123' },
      signal: new AbortController().signal,
      challenge: { deviceCode: 'device', userCode: 'user', verificationUri: 'https://example.test', verificationUriComplete: null, intervalMs: 1, expiresAtMs: 99 },
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    expect(credentials.storeExchangedTokens.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]);
    expect(credentials.discardStaged).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'authorized', account: { permissionId: 'permission-1', email: null, displayName: 'Drive admin' } }));
  });

  it('retains exchanged staging when authorized outcome delivery rejects', async () => {
    const credentials = {
      storeExchangedTokens: vi.fn().mockResolvedValue(true),
      discardStaged: vi.fn(),
      expireStaged: vi.fn(),
      loadStaged: vi.fn().mockResolvedValue({ id: 'generation-00001' }),
    };
    const publish = vi.fn().mockRejectedValue(new Error('provider body: client_secret=must-not-log'));
    const unhandled = vi.fn();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.on('unhandledRejection', unhandled);
    const polling = new DriveAuthorizationPollingService(
      { poll: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', expiryDateMs: null, tokenType: null, scope: null }) } as never,
      credentials,
      { resolveAccount: vi.fn().mockResolvedValue({ permissionId: 'permission-1', email: null, displayName: 'Drive admin' }) },
      { publish },
    );

    try {
      polling.start({ generationId: 'generation-00001', expectedRevision: 0, receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
        client: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret-123' },
        signal: new AbortController().signal,
        challenge: { deviceCode: 'device', userCode: 'user', verificationUri: 'https://example.test', verificationUriComplete: null, intervalMs: 1, expiresAtMs: 99 },
      });
      await vi.waitFor(() => expect(publish).toHaveBeenCalled());
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(credentials.discardStaged).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'authorized' }));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Drive authorization background task failed');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('must-not-log');
    } finally {
      process.off('unhandledRejection', unhandled);
      warn.mockRestore();
    }
  });

  it('aborts the provider poll when the registry-owned signal is cancelled', async () => {
    const registry = new AbortController();
    const poll = vi.fn(async (_client: unknown, _challenge: unknown, signal: AbortSignal) => {
      await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const credentials = { storeExchangedTokens: vi.fn(), discardStaged: vi.fn(), expireStaged: vi.fn(), loadStaged: vi.fn() };
    const publish = vi.fn();
    const polling = new DriveAuthorizationPollingService(
      { poll } as never, credentials, { resolveAccount: vi.fn() }, { publish },
    );

    polling.start({ generationId: 'generation-00001', expectedRevision: 0, receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
      client: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret-123' }, signal: registry.signal,
      challenge: { deviceCode: 'device', userCode: 'user', verificationUri: 'https://example.test', verificationUriComplete: null, intervalMs: 1, expiresAtMs: 99 },
    });
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
    registry.abort(new DOMException('Cancelled', 'AbortError'));
    await vi.waitFor(() => expect(poll.mock.calls[0]?.[2]?.aborted).toBe(true));

    expect(credentials.discardStaged).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('aborts the provider poll when its local request is cancelled', async () => {
    const registry = new AbortController();
    const poll = vi.fn(async (_client: unknown, _challenge: unknown, signal: AbortSignal) => {
      await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const credentials = { storeExchangedTokens: vi.fn(), discardStaged: vi.fn(), expireStaged: vi.fn(), loadStaged: vi.fn() };
    const publish = vi.fn();
    const polling = new DriveAuthorizationPollingService(
      { poll } as never, credentials, { resolveAccount: vi.fn() }, { publish },
    );

    polling.start({ generationId: 'generation-00001', expectedRevision: 0, receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
      client: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret-123' }, signal: registry.signal,
      challenge: { deviceCode: 'device', userCode: 'user', verificationUri: 'https://example.test', verificationUriComplete: null, intervalMs: 1, expiresAtMs: 99 },
    });
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
    polling.cancel('generation-00001');
    await vi.waitFor(() => expect(poll.mock.calls[0]?.[2]?.aborted).toBe(true));

    expect(registry.signal.aborted).toBe(false);
    expect(credentials.discardStaged).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('releases generation leases and resumable sessions before revoking credentials', async () => {
    const order: string[] = [];
    const credentials = {
      loadActive: vi.fn().mockResolvedValue({ id: 'generation-00001', revision: 1 }),
      loadCredentials: vi.fn().mockResolvedValue({ tokens: { refreshToken: 'refresh' } }),
      beginDisconnect: vi.fn().mockImplementation(async () => { order.push('disconnect'); return { id: 'generation-00001' }; }),
      completeSecretRemoval: vi.fn().mockImplementation(async () => { order.push('remove'); }),
    };
    const archive = {
      releaseGenerationLeases: vi.fn().mockImplementation(async () => { order.push('release-leases'); }),
      clearGenerationSessions: vi.fn().mockImplementation(async () => { order.push('clear-sessions'); }),
    };
    const useCase = new DisconnectDriveUseCase(credentials, { revoke: vi.fn().mockImplementation(async () => { order.push('revoke'); }) }, { cancel: vi.fn() } as never, archive, { now: () => new Date(4) });

    await useCase.execute('generation-00001', new AbortController().signal);

    expect(order).toEqual(['disconnect', 'release-leases', 'clear-sessions', 'revoke', 'remove']);
  });
});
