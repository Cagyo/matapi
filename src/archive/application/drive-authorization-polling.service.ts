import type { OnModuleInit } from '@nestjs/common';
import type { DriveAuthorizationOutcomePort } from './ports/drive-authorization-outcome.port';
import type { DriveDeviceAuthorizationPort, DeviceAuthorizationChallenge } from './ports/drive-device-authorization.port';
import type { DriveClientCredentials, DriveCredentialRepositoryPort } from './ports/drive-credential-repository.port';
import { DriveAuthorizationDeniedError } from '../domain/errors/drive-authorization-denied.error';
import { DriveReauthorizationRequiredError } from '../domain/errors/drive-reauthorization-required.error';

export interface StartDriveAuthorizationPolling {
  generationId: string;
  expectedRevision: number;
  receiptId: string;
  adminUserId: number;
  chatId: number;
  client: DriveClientCredentials;
  challenge: DeviceAuthorizationChallenge;
}

/**
 * Owns process-memory-only device codes and starts a poll without awaiting it
 * from Telegram's update handler.
 */
export class DriveAuthorizationPollingService implements OnModuleInit {
  private readonly requests = new Map<string, AbortController>();

  constructor(
    private readonly authorization: DriveDeviceAuthorizationPort,
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'storeExchangedTokens' | 'discardStaged' | 'expireStaged'>,
    private readonly outcomes: DriveAuthorizationOutcomePort,
  ) {}

  /** Device codes are memory-only, so every durable staged secret is unsafe after a restart. */
  async onModuleInit(): Promise<void> {
    await this.credentials.expireStaged(Number.MAX_SAFE_INTEGER);
  }

  start(input: StartDriveAuthorizationPolling): void {
    this.cancel(input.generationId);
    const controller = new AbortController();
    this.requests.set(input.generationId, controller);
    void this.poll(input, controller).finally(() => {
      if (this.requests.get(input.generationId) === controller) {
        this.requests.delete(input.generationId);
      }
    });
  }

  cancel(generationId: string): void {
    const controller = this.requests.get(generationId);
    if (controller) controller.abort();
    this.requests.delete(generationId);
  }

  cancelAll(): void {
    for (const generationId of this.requests.keys()) this.cancel(generationId);
  }

  private async poll(input: StartDriveAuthorizationPolling, controller: AbortController): Promise<void> {
    try {
      const tokens = await this.authorization.poll(input.client, input.challenge, controller.signal);
      if (controller.signal.aborted) return;
      const stored = await this.credentials.storeExchangedTokens(input.generationId, input.expectedRevision, tokens);
      if (!stored) return;
      await this.outcomes.publish({
        kind: 'authorized',
        generationId: input.generationId,
        receiptId: input.receiptId,
        adminUserId: input.adminUserId,
        chatId: input.chatId,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      await this.credentials.discardStaged(input.generationId, input.receiptId);
      await this.outcomes.publish({ ...binding(input, 'failed'), reason: reasonFor(error) });
    }
  }
}

function binding(input: StartDriveAuthorizationPolling, kind: 'failed') {
  return {
    kind,
    generationId: input.generationId,
    receiptId: input.receiptId,
    adminUserId: input.adminUserId,
    chatId: input.chatId,
  } as const;
}

function reasonFor(error: unknown): 'denied' | 'expired' | 'unavailable' {
  if (error instanceof DriveAuthorizationDeniedError) return 'denied';
  if (error instanceof DriveReauthorizationRequiredError) return 'expired';
  return 'unavailable';
}
