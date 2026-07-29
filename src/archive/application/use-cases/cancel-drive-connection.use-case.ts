import type { DriveAuthorizationPollingService } from '../drive-authorization-polling.service';
import type { DriveCredentialRepositoryPort } from '../ports/drive-credential-repository.port';

/** Cancels only the exact staged generation; an old callback cannot cancel a replacement. */
export class CancelDriveConnectionUseCase {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadStaged' | 'discardStaged'>,
    private readonly polling: DriveAuthorizationPollingService,
  ) {}

  async execute(input: { generationId: string; receiptId: string; adminUserId: number; chatId: number }): Promise<'cancelled' | 'stale'> {
    const staged = await this.credentials.loadStaged(input.receiptId, input);
    if (!staged) return 'stale';
    this.polling.cancel(staged.id);
    return await this.credentials.discardStaged(staged.id, input.receiptId) ? 'cancelled' : 'stale';
  }
}
