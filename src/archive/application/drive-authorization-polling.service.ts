import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type {
  DriveAuthorizationFailureReason,
  DriveAuthorizationOutcomePort,
} from './ports/drive-authorization-outcome.port';
import type { DriveDeviceAuthorizationPort, DeviceAuthorizationChallenge } from './ports/drive-device-authorization.port';
import type { DriveClientCredentials, DriveCredentialRepositoryPort } from './ports/drive-credential-repository.port';
import type { DriveAccountPort } from './ports/drive-account.port';
import { DriveAuthorizationDeniedError } from '../domain/errors/drive-authorization-denied.error';
import { DriveOAuthClientRejectedError } from '../domain/errors/drive-oauth-client-rejected.error';
import { DrivePolicyBlockedError } from '../domain/errors/drive-policy-blocked.error';
import { DriveProviderResponseError } from '../domain/errors/drive-provider-response.error';
import { DriveRateLimitedError } from '../domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../domain/errors/drive-temporary-unavailable.error';

/** Archive-owned runtime seam for Telegram authorization outcomes. */
@Injectable()
export class DriveAuthorizationOutcomeRegistrationService
implements DriveAuthorizationOutcomePort {
  private readonly logger = new Logger(DriveAuthorizationOutcomeRegistrationService.name);
  private delegate: DriveAuthorizationOutcomePort | null = null;

  register(delegate: DriveAuthorizationOutcomePort): void {
    this.delegate = delegate;
  }

  clear(delegate?: DriveAuthorizationOutcomePort): void {
    if (delegate === undefined || this.delegate === delegate) this.delegate = null;
  }

  async publish(outcome: Parameters<DriveAuthorizationOutcomePort['publish']>[0]): Promise<void> {
    if (this.delegate === null) {
      this.logger.warn('No Drive authorization outcome delegate is registered');
      return;
    }
    await this.delegate.publish(outcome);
  }
}

export interface StartDriveAuthorizationPolling {
  generationId: string;
  expectedRevision: number;
  receiptId: string;
  adminUserId: number;
  chatId: number;
  client: DriveClientCredentials;
  signal: AbortSignal;
  challenge: DeviceAuthorizationChallenge;
}

/**
 * Owns process-memory-only device codes and starts a poll without awaiting it
 * from Telegram's update handler.
 */
@Injectable()
export class DriveAuthorizationPollingService implements OnModuleInit {
  private readonly requests = new Map<string, AbortController>();

  constructor(
    private readonly authorization: DriveDeviceAuthorizationPort,
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'storeExchangedTokens' | 'discardStaged' | 'expireStaged' | 'loadStaged'>,
    private readonly accounts: Pick<DriveAccountPort, 'resolveAccount'>,
    private readonly outcomes: DriveAuthorizationOutcomePort,
  ) {}

  /** Device codes are memory-only, so every durable staged secret is unsafe after a restart. */
  async onModuleInit(): Promise<void> {
    await this.credentials.expireStaged(Number.MAX_SAFE_INTEGER);
  }

  start(input: StartDriveAuthorizationPolling): void {
    this.cancel(input.generationId);
    const local = new AbortController();
    this.requests.set(input.generationId, local);
    const signal = AbortSignal.any([input.signal, local.signal]);
    void this.poll(input, signal).finally(() => {
      if (this.requests.get(input.generationId) === local) {
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

  private async poll(input: StartDriveAuthorizationPolling, signal: AbortSignal): Promise<void> {
    try {
      const tokens = await this.authorization.poll(input.client, input.challenge, signal);
      if (signal.aborted) return;
      const stored = await this.credentials.storeExchangedTokens(input.generationId, input.expectedRevision, tokens);
      if (!stored) return;
      const staged = await this.credentials.loadStaged(input.receiptId, {
        generationId: input.generationId,
        adminUserId: input.adminUserId,
        chatId: input.chatId,
      });
      if (!staged) return;
      const account = await this.accounts.resolveAccount(staged, signal);
      await this.outcomes.publish({
        kind: 'authorized',
        generationId: input.generationId,
        receiptId: input.receiptId,
        adminUserId: input.adminUserId,
        chatId: input.chatId,
        account,
      });
    } catch (error) {
      if (signal.aborted) return;
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

function reasonFor(error: unknown): DriveAuthorizationFailureReason {
  if (error instanceof DriveAuthorizationDeniedError) return 'denied';
  if (error instanceof DriveReauthorizationRequiredError) return 'expired';
  if (error instanceof DrivePolicyBlockedError) return 'policy';
  if (error instanceof DriveRateLimitedError) return 'rate-limited';
  if (error instanceof DriveOAuthClientRejectedError) return 'client-rejected';
  if (error instanceof DriveProviderResponseError) return 'provider-response';
  if (error instanceof DriveTemporaryUnavailableError) return 'unavailable';
  return 'unavailable';
}
