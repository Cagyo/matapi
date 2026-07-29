import type { DriveAuthorizationPollingService } from '../drive-authorization-polling.service';
import type { DriveDeviceAuthorizationPort } from '../ports/drive-device-authorization.port';
import type { DriveClientCredentials, DriveCredentialRepositoryPort } from '../ports/drive-credential-repository.port';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { hashDriveClientId, type PendingDriveConnection } from './begin-drive-connection.use-case';

const ALLOWED_INSTALLED_KEYS = new Set([
  'client_id', 'project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_secret', 'redirect_uris', 'javascript_origins',
]);

export interface DriveClientSubmissionResult {
  verificationUri: string;
  userCode: string;
  expiresAtMs: number;
}

/** Validates an installed-client document and starts its device poll asynchronously. */
export class SubmitDriveClientUseCase {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'stage' | 'discardStaged'>,
    private readonly authorization: Pick<DriveDeviceAuthorizationPort, 'requestCode'>,
    private readonly polling: DriveAuthorizationPollingService,
  ) {}

  async execute(input: { pending: PendingDriveConnection; document: string; signal: AbortSignal }): Promise<DriveClientSubmissionResult> {
    if (input.pending.expiresAtMs <= Date.now()) throw new DriveConfigurationError('Drive setup invitation has expired');
    const client = parseInstalledClient(input.document);
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
      const challenge = await this.authorization.requestCode(client, input.signal);
      this.polling.start({
        generationId: staged.id,
        expectedRevision: staged.revision,
        receiptId: input.pending.receiptId,
        adminUserId: input.pending.adminUserId,
        chatId: input.pending.chatId,
        client,
        challenge,
      });
      return { verificationUri: challenge.verificationUri, userCode: challenge.userCode, expiresAtMs: challenge.expiresAtMs };
    } catch (error) {
      await this.credentials.discardStaged(staged.id, input.pending.receiptId);
      throw error;
    }
  }
}

export function parseInstalledClient(document: string): DriveClientCredentials {
  let value: unknown;
  try { value = JSON.parse(document); } catch { throw new DriveConfigurationError('Drive client document is not JSON'); }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.installed)) {
    throw new DriveConfigurationError('Drive client document must contain only installed credentials');
  }
  const installed = value.installed;
  if (Object.keys(installed).some((key) => !ALLOWED_INSTALLED_KEYS.has(key))) {
    throw new DriveConfigurationError('Drive client document contains unsupported fields');
  }
  if (!isClientId(installed.client_id) || !isClientSecret(installed.client_secret)) {
    throw new DriveConfigurationError('Drive client document is invalid');
  }
  if (!validOptionalInstalledFields(installed)) throw new DriveConfigurationError('Drive client document is invalid');
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

function validOptionalInstalledFields(value: Record<string, unknown>): boolean {
  for (const key of ['project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url']) {
    if (key in value && typeof value[key] !== 'string') return false;
  }
  for (const key of ['redirect_uris', 'javascript_origins']) {
    if (key in value && (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === 'string'))) return false;
  }
  return true;
}

function isClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+(?:-[A-Za-z0-9]+)*\.apps\.googleusercontent\.com$/.test(value);
}

function isClientSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
