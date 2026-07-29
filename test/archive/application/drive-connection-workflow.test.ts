import { describe, expect, it, vi } from 'vitest';
import { DriveAuthorizationPollingService } from '../../../src/archive/application/drive-authorization-polling.service';
import { DisconnectDriveUseCase } from '../../../src/archive/application/use-cases/disconnect-drive.use-case';
import { ConfirmDriveAccountUseCase } from '../../../src/archive/application/use-cases/confirm-drive-account.use-case';
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

    await expect(workflow.execute({ generationId: 'pending-generation', receiptId: 'pending-receipt', adminUserId: 7, chatId: 9, signal: new AbortController().signal }))
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
});

describe('background authorization and disconnect', () => {
  it('publishes the approved account identity only after it persists exchanged tokens', async () => {
    const credentials = {
      storeExchangedTokens: vi.fn().mockResolvedValue(true), discardStaged: vi.fn(), expireStaged: vi.fn(),
      loadStaged: vi.fn().mockResolvedValue({ id: 'generation-00001' }),
    };
    const publish = vi.fn().mockResolvedValue(undefined);
    const polling = new DriveAuthorizationPollingService(
      { poll: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', expiryDateMs: null, tokenType: null, scope: null }) } as never,
      credentials as never,
      { resolveAccount: vi.fn().mockResolvedValue({ permissionId: 'permission-1', email: null, displayName: 'Drive admin' }) } as never,
      { publish } as never,
    );

    polling.start({ generationId: 'generation-00001', expectedRevision: 0, receiptId: 'abcdefghijklmnop', adminUserId: 7, chatId: 9,
      client: { clientId: '123.apps.googleusercontent.com', clientSecret: 'secret-123' },
      challenge: { deviceCode: 'device', userCode: 'user', verificationUri: 'https://example.test', verificationUriComplete: null, intervalMs: 1, expiresAtMs: 99 },
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    expect(credentials.storeExchangedTokens.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'authorized', account: { permissionId: 'permission-1', email: null, displayName: 'Drive admin' } }));
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
    const useCase = new DisconnectDriveUseCase(credentials as never, { revoke: vi.fn().mockImplementation(async () => { order.push('revoke'); }) } as never, { cancel: vi.fn() } as never, archive as never, { now: () => new Date(4) });

    await useCase.execute('generation-00001', new AbortController().signal);

    expect(order).toEqual(['disconnect', 'release-leases', 'clear-sessions', 'revoke', 'remove']);
  });
});
