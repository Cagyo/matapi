import type { ClockPort } from '../../../events/domain/ports/clock.port';
import type { DriveAccountPort } from '../ports/drive-account.port';
import type { DriveCredentialRepositoryPort } from '../ports/drive-credential-repository.port';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { DriveSetupExpiredError } from '../../domain/errors/drive-setup-expired.error';

/** Binds the approved account to the exact staged receipt and activates it atomically. */
export class ConfirmDriveAccountUseCase {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadStaged' | 'loadCredentials' | 'activate' | 'discardStaged'>,
    private readonly accounts: DriveAccountPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: {
    generationId: string;
    receiptId: string;
    adminUserId: number;
    chatId: number;
    effectiveDeadlineMs: number;
    signal: AbortSignal;
  }): Promise<'activated' | 'pending' | 'stale'> {
    const staged = await this.loadBound(input);
    if (!staged) return 'stale';
    try {
      this.assertLive(input.effectiveDeadlineMs);
      const material = await this.credentials.loadCredentials(staged.id);
      // Confirmation may happen before the background poll exchanges tokens.
      // Keep the exact staged generation intact until credentials exist.
      if (!material?.tokens.accessToken && !material?.tokens.refreshToken) return 'pending';
      const account = await this.accounts.resolveAccount(staged, input.signal);
      const folders = await this.accounts.resolveManagedFolders(staged, input.signal);
      this.assertLive(input.effectiveDeadlineMs);
      this.assertLive(input.effectiveDeadlineMs);
      await this.credentials.activate({ stagedId: staged.id, expectedRevision: staged.revision, ...account, folders, activatedAtMs: this.clock.now().getTime() });
      return 'activated';
    } catch (error) {
      await this.credentials.discardStaged(staged.id, input.receiptId);
      throw error;
    }
  }

  async rejectAccount(input: { generationId?: string; receiptId: string; adminUserId: number; chatId: number }): Promise<void> {
    const staged = await this.loadBound(input);
    if (staged) await this.credentials.discardStaged(staged.id, input.receiptId);
  }

  private async loadBound(input: { generationId?: string; receiptId: string; adminUserId: number; chatId: number }) {
    const staged = await this.credentials.loadStaged(input.receiptId, input);
    if (!staged) return null;
    if (!Number.isSafeInteger(input.adminUserId) || !Number.isSafeInteger(input.chatId)) {
      throw new DriveConfigurationError('Drive confirmation binding is invalid');
    }
    return staged;
  }

  private assertLive(effectiveDeadlineMs: number): void {
    if (!Number.isSafeInteger(effectiveDeadlineMs)
      || effectiveDeadlineMs <= this.clock.now().getTime()) throw new DriveSetupExpiredError();
  }
}
