import { describe, expect, it } from 'vitest';
import { ConfirmDriveAccountUseCase } from '../../../src/archive/application/use-cases/confirm-drive-account.use-case';
import { InMemoryDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-credential.repository';

describe('Drive connection workflow', () => {
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
