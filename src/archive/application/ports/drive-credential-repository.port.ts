import type { DriveConnectionStatus } from '../../domain/drive-connection.entity';
import type { DriveConnection } from '../../domain/drive-connection.entity';

export const DRIVE_CREDENTIAL_REPOSITORY = Symbol('DRIVE_CREDENTIAL_REPOSITORY');

export interface DriveClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthTokenSet {
  accessToken: string | null;
  refreshToken: string | null;
  expiryDateMs: number | null;
  tokenType: string | null;
  scope: string | null;
}

export interface StageDriveConnection {
  id: string;
  installationId: string;
  client: DriveClientCredentials;
  clientIdHash: string;
  adminUserId: number;
  chatId: number;
  receiptId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ActivateDriveConnection {
  stagedId: string;
  expectedRevision: number;
  permissionId: string;
  email: string | null;
  displayName: string | null;
  folders: { rootId: string; motionId: string; backupsId: string };
  activatedAtMs: number;
}

export interface MergeRefreshedTokens {
  generationId: string;
  expectedRevision: number;
  tokens: OAuthTokenSet;
  refreshedAtMs: number;
}

export type DriveConnectionTerminalStatus = Extract<
  DriveConnectionStatus,
  'retired_unmanaged' | 'disconnected'
>;

export interface DriveCredentialRepositoryPort {
  stage(input: StageDriveConnection): Promise<DriveConnection>;
  loadStaged(receiptId: string): Promise<DriveConnection | null>;
  storeExchangedTokens(id: string, expectedRevision: number, tokens: OAuthTokenSet): Promise<boolean>;
  activate(input: ActivateDriveConnection): Promise<{ active: DriveConnection; retiringId: string | null }>;
  loadActive(): Promise<DriveConnection | null>;
  loadCredentials(generationId: string): Promise<{ client: DriveClientCredentials; tokens: OAuthTokenSet; revision: number } | null>;
  replaceCredentials(generationId: string, expectedRevision: number, client: DriveClientCredentials, tokens: OAuthTokenSet): Promise<DriveConnection>;
  mergeRefreshedTokens(input: MergeRefreshedTokens): Promise<boolean>;
  requireReauthorization(generationId: string, expectedRevision: number, errorCode: string, atMs: number): Promise<boolean>;
  beginDisconnect(generationId: string, expectedRevision: number): Promise<DriveConnection>;
  completeSecretRemoval(generationId: string, terminal: DriveConnectionTerminalStatus, atMs: number, revocationErrorCode: string | null): Promise<void>;
  listInterruptedMaintenance(): Promise<readonly DriveConnection[]>;
  expireStaged(nowMs: number): Promise<readonly string[]>;
}
