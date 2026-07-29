import { auth, drive } from '@googleapis/drive';
import { Inject, Injectable } from '@nestjs/common';
import type { DriveAccountIdentity, DriveAccountPort, DriveQuota, ManagedDriveFolders } from '../../application/ports/drive-account.port';
import { DRIVE_CREDENTIAL_REPOSITORY, type DriveCredentialRepositoryPort } from '../../application/ports/drive-credential-repository.port';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { GoogleDriveAccountAdapter } from './google-drive-account.adapter';
import { GoogleDriveGateway } from './google-drive.gateway';

/** Builds an SDK client only from the exact encrypted credentials of the requested generation. */
@Injectable()
export class GoogleDriveConnectionAccountAdapter implements DriveAccountPort {
  constructor(
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadCredentials' | 'loadManagedFolderReservation' | 'reserveManagedFolder'>,
  ) {}

  async resolveAccount(connection: DriveConnection, signal: AbortSignal): Promise<DriveAccountIdentity> {
    return (await this.forConnection(connection)).resolveAccount(connection, signal);
  }

  async readQuota(connection: DriveConnection, signal: AbortSignal): Promise<DriveQuota> {
    return (await this.forConnection(connection)).readQuota(connection, signal);
  }

  async resolveManagedFolders(connection: DriveConnection, signal: AbortSignal): Promise<ManagedDriveFolders> {
    return (await this.forConnection(connection)).resolveManagedFolders(connection, signal);
  }

  private async forConnection(connection: DriveConnection): Promise<GoogleDriveAccountAdapter> {
    const material = await this.credentials.loadCredentials(connection.id);
    if (!material) throw new DriveConfigurationError('Drive connection credentials are unavailable');
    // Use the auth constructor exported by the Drive SDK so its private types
    // stay aligned with the SDK's pinned googleapis-common dependency.
    const oauth = new auth.OAuth2(material.client.clientId, material.client.clientSecret);
    oauth.setCredentials({
      access_token: material.tokens.accessToken,
      refresh_token: material.tokens.refreshToken,
      expiry_date: material.tokens.expiryDateMs,
      token_type: material.tokens.tokenType,
      scope: material.tokens.scope ?? undefined,
    });
    return new GoogleDriveAccountAdapter(new GoogleDriveGateway(drive({ version: 'v3', auth: oauth })), this.credentials);
  }
}
