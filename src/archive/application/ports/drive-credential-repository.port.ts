import type { DriveConnectionStatus } from '../../domain/drive-connection.entity';
import type { DriveConnection, DriveConnectionSnapshot } from '../../domain/drive-connection.entity';

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

export interface DriveQuotaReclamationState {
  windowStartedMs: number | null;
  reclaimedBytes: number;
}

export interface CompareAndSetDriveQuotaReclamation {
  generationId: string;
  expected: DriveQuotaReclamationState;
  next: DriveQuotaReclamationState;
}

export type ManagedFolderRole = 'root' | 'motion' | 'backups';

/** Partial exact-ID reservations survive a provider timeout before activation. */
export interface ManagedFolderReservation {
  revision: number;
  rootId: string | null;
  motionId: string | null;
  backupsId: string | null;
}

export interface ReserveManagedFolder {
  generationId: string;
  expectedRevision: number;
  role: ManagedFolderRole;
  folderId: string;
}

export const DRIVE_CREDENTIAL_ERROR_CODES = [
  'authorization_required',
  'access_denied',
  'temporarily_unavailable',
  'rate_limited',
  'network_unavailable',
  'unknown',
] as const;

export type DriveCredentialErrorCode = (typeof DRIVE_CREDENTIAL_ERROR_CODES)[number];

/** Sanitized, credential-free connection projection used by private admin status. */
export interface DriveStatusConnection extends DriveConnectionSnapshot {
  errorCode: string | null;
}

export type DriveConnectionTerminalStatus = Extract<
  DriveConnectionStatus,
  'retired_unmanaged' | 'disconnected'
>;

export interface DriveCredentialRepositoryPort {
  stage(input: StageDriveConnection): Promise<DriveConnection>;
  loadStaged(receiptId: string, binding?: { generationId?: string; adminUserId: number; chatId: number }): Promise<DriveConnection | null>;
  /** Removes a still-staged generation and its encrypted material by its exact receipt binding. */
  discardStaged(id: string, receiptId: string): Promise<boolean>;
  storeExchangedTokens(id: string, expectedRevision: number, tokens: OAuthTokenSet): Promise<boolean>;
  loadManagedFolderReservation(generationId: string): Promise<ManagedFolderReservation | null>;
  reserveManagedFolder(input: ReserveManagedFolder): Promise<ManagedFolderReservation | null>;
  activate(input: ActivateDriveConnection): Promise<{ active: DriveConnection; retiringId: string | null }>;
  loadActive(): Promise<DriveConnection | null>;
  listStatusConnections(): Promise<readonly DriveStatusConnection[]>;
  readAlertCooldowns(generationId: string): Promise<Readonly<Record<string, number>> | null>;
  compareAndSetAlertCooldowns(input: {
    generationId: string;
    expected: Readonly<Record<string, number>>;
    next: Readonly<Record<string, number>>;
  }): Promise<boolean>;
  readQuotaReclamation(generationId: string): Promise<DriveQuotaReclamationState | null>;
  compareAndSetQuotaReclamation(input: CompareAndSetDriveQuotaReclamation): Promise<boolean>;
  loadCredentials(generationId: string): Promise<{ client: DriveClientCredentials; tokens: OAuthTokenSet; revision: number } | null>;
  replaceCredentials(generationId: string, expectedRevision: number, client: DriveClientCredentials, tokens: OAuthTokenSet): Promise<DriveConnection>;
  mergeRefreshedTokens(input: MergeRefreshedTokens): Promise<boolean>;
  requireReauthorization(generationId: string, expectedRevision: number, errorCode: string, atMs: number): Promise<boolean>;
  beginDisconnect(generationId: string, expectedRevision: number): Promise<DriveConnection>;
  completeSecretRemoval(generationId: string, terminal: DriveConnectionTerminalStatus, atMs: number, revocationErrorCode: string | null): Promise<void>;
  listInterruptedMaintenance(): Promise<readonly DriveConnection[]>;
  expireStaged(nowMs: number): Promise<readonly string[]>;
}
