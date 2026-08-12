import type { DriveAuthorizationPollingService } from '../drive-authorization-polling.service';
import type { DriveDeviceAuthorizationPort } from '../ports/drive-device-authorization.port';
import type { DriveClientCredentials, DriveCredentialRepositoryPort } from '../ports/drive-credential-repository.port';
import type { ClockPort } from '../../../events/domain/ports/clock.port';
import { DriveClientDocumentError } from '../../domain/errors/drive-client-document.error';
import { DriveSetupExpiredError } from '../../domain/errors/drive-setup-expired.error';
import { hashDriveClientId, type PendingDriveConnection } from './begin-drive-connection.use-case';

export interface DriveClientSubmissionResult {
  verificationUri: string;
  userCode: string;
  effectiveDeadlineMs: number;
}

export interface DriveChallengeBinding {
  generationId: string;
  effectiveDeadlineMs: number;
}

/** Validates an installed-client document and starts its device poll asynchronously. */
export class SubmitDriveClientUseCase {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'stage' | 'discardStaged'>,
    private readonly authorization: Pick<DriveDeviceAuthorizationPort, 'requestCode'>,
    private readonly polling: DriveAuthorizationPollingService,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: {
    pending: PendingDriveConnection;
    document: string;
    signal: AbortSignal;
    authorizationSignal: AbortSignal;
    acceptChallenge(binding: DriveChallengeBinding): boolean;
  }): Promise<DriveClientSubmissionResult> {
    throwIfAborted(input.signal);
    const nowMs = this.clock.now().getTime();
    if (input.pending.expiresAtMs <= nowMs) throw new DriveSetupExpiredError();
    const client = parseInstalledClient(input.document);
    throwIfAborted(input.signal);
    const staged = await this.credentials.stage({
      id: input.pending.generationId,
      installationId: input.pending.installationId,
      client,
      clientIdHash: hashDriveClientId(client.clientId),
      adminUserId: input.pending.adminUserId,
      chatId: input.pending.chatId,
      receiptId: input.pending.receiptId,
      createdAtMs: input.pending.createdAtMs,
      expiresAtMs: input.pending.expiresAtMs,
    });
    try {
      throwIfAborted(input.signal);
      const challenge = await this.authorization.requestCode(client, input.signal);
      const effectiveDeadlineMs = Math.min(input.pending.expiresAtMs, challenge.expiresAtMs);
      if (effectiveDeadlineMs <= this.clock.now().getTime()
        || !input.acceptChallenge({ generationId: staged.id, effectiveDeadlineMs })) {
        throw new DriveSetupExpiredError();
      }
      this.polling.start({
        generationId: staged.id,
        expectedRevision: staged.revision,
        receiptId: input.pending.receiptId,
        adminUserId: input.pending.adminUserId,
        chatId: input.pending.chatId,
        client,
        signal: input.authorizationSignal,
        challenge: { ...challenge, expiresAtMs: effectiveDeadlineMs },
      });
      return { verificationUri: challenge.verificationUri, userCode: challenge.userCode, effectiveDeadlineMs };
    } catch (error) {
      await this.credentials.discardStaged(staged.id, input.pending.receiptId);
      throw error;
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

export function parseInstalledClient(document: string): DriveClientCredentials {
  const withoutBom = document.startsWith('\uFEFF') ? document.slice(1) : document;
  if (withoutBom.startsWith('\uFEFF')) throw new DriveClientDocumentError('invalid-utf8');
  let value: unknown;
  try { value = JSON.parse(withoutBom); } catch { throw new DriveClientDocumentError('malformed-json'); }
  if (!isRecord(value)) throw new DriveClientDocumentError('invalid-credentials');
  if ('web' in value) throw new DriveClientDocumentError('unsupported-client-type');
  if (Object.keys(value).length !== 1 || !isRecord(value.installed)) {
    throw new DriveClientDocumentError('invalid-credentials');
  }
  const installed = value.installed;
  if (!isClientId(installed.client_id) || !isClientSecret(installed.client_secret)) {
    throw new DriveClientDocumentError('invalid-credentials');
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

function isClientId(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= 512
    && /^[0-9]+(?:-[A-Za-z0-9]+)*\.apps\.googleusercontent\.com$/.test(value);
}

function isClientSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
