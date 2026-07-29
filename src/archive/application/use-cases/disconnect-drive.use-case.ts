import type { ClockPort } from '../../../events/domain/ports/clock.port';
import type { DriveAuthorizationPollingService } from '../drive-authorization-polling.service';
import type { DriveDeviceAuthorizationPort } from '../ports/drive-device-authorization.port';
import type { DriveCredentialRepositoryPort } from '../ports/drive-credential-repository.port';
import type { ArchiveArtifactRepositoryPort } from '../ports/archive-artifact-repository.port';

/** Retires live secrets for the active generation without touching archive rows or remote files. */
export class DisconnectDriveUseCase {
  constructor(
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadActive' | 'loadCredentials' | 'beginDisconnect' | 'completeSecretRemoval'>,
    private readonly authorization: Pick<DriveDeviceAuthorizationPort, 'revoke'>,
    private readonly polling: DriveAuthorizationPollingService,
    private readonly archive: Pick<ArchiveArtifactRepositoryPort, 'releaseGenerationLeases' | 'clearGenerationSessions'>,
    private readonly clock: ClockPort,
  ) {}

  async activeGeneration(): Promise<string | null> {
    return (await this.credentials.loadActive())?.id ?? null;
  }

  async execute(generationId: string, signal: AbortSignal): Promise<'disconnected' | 'not-connected' | 'stale'> {
    const active = await this.credentials.loadActive();
    if (!active) return 'not-connected';
    if (active.id !== generationId) return 'stale';
    this.polling.cancel(active.id);
    const material = await this.credentials.loadCredentials(active.id);
    const disconnecting = await this.credentials.beginDisconnect(active.id, active.revision);
    const nowMs = this.clock.now().getTime();
    await this.archive.releaseGenerationLeases(disconnecting.id, nowMs);
    await this.archive.clearGenerationSessions(disconnecting.id, nowMs);
    const token = material?.tokens.refreshToken ?? material?.tokens.accessToken;
    let revocationErrorCode: string | null = null;
    if (token) {
      try { await this.authorization.revoke(token, signal); }
      catch (error) { revocationErrorCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'; }
    }
    await this.credentials.completeSecretRemoval(disconnecting.id, 'disconnected', nowMs, revocationErrorCode);
    return 'disconnected';
  }
}
