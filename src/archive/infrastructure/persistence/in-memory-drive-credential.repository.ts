import type {
  ActivateDriveConnection,
  DriveClientCredentials,
  DriveConnectionTerminalStatus,
  CompareAndSetDriveQuotaReclamation,
  DriveQuotaReclamationState,
  DriveCredentialRepositoryPort,
  DriveStatusConnection,
  MergeRefreshedTokens,
  ManagedFolderReservation,
  ManagedFolderRole,
  OAuthTokenSet,
  ReserveManagedFolder,
  StageDriveConnection,
} from '../../application/ports/drive-credential-repository.port';
import { DriveConnection } from '../../domain/drive-connection.entity';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';

interface Entry {
  connection: DriveConnection;
  clientIdHash: string;
  client: DriveClientCredentials | null;
  tokens: OAuthTokenSet | null;
  receiptId: string | null;
  adminUserId: number | null;
  chatId: number | null;
  expiresAtMs: number | null;
  reservations: Omit<ManagedFolderReservation, 'revision'>;
  quotaReclamation: DriveQuotaReclamationState;
  alertCooldowns: Record<string, number>;
}

/** In-memory parity adapter for isolated use-case tests. */
export class InMemoryDriveCredentialRepository implements DriveCredentialRepositoryPort {
  private readonly entries = new Map<string, Entry>();

  async stage(input: StageDriveConnection): Promise<DriveConnection> {
    if ([...this.entries.values()].some(({ connection }) => connection.status === 'staged')) throw conflict('A Drive setup is already staged');
    const connection = DriveConnection.stage({ id: input.id, installationId: input.installationId, nowMs: input.createdAtMs });
    this.entries.set(input.id, { connection, clientIdHash: input.clientIdHash, client: { ...input.client }, tokens: emptyTokens(), receiptId: input.receiptId, adminUserId: input.adminUserId, chatId: input.chatId, expiresAtMs: input.expiresAtMs, reservations: emptyReservations(), quotaReclamation: emptyQuotaReclamation(), alertCooldowns: {} });
    return connection;
  }

  async loadStaged(receiptId: string, binding?: { generationId?: string; adminUserId: number; chatId: number }): Promise<DriveConnection | null> {
    return [...this.entries.values()].find((entry) => entry.connection.status === 'staged'
      && entry.receiptId === receiptId
      && (binding === undefined || (entry.connection.id === (binding.generationId ?? entry.connection.id)
        && entry.adminUserId === binding.adminUserId && entry.chatId === binding.chatId)))?.connection ?? null;
  }

  async discardStaged(id: string, receiptId: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry?.connection.status !== 'staged' || entry.receiptId !== receiptId) return false;
    this.entries.delete(id);
    return true;
  }

  async storeExchangedTokens(id: string, expectedRevision: number, tokens: OAuthTokenSet): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry?.connection.status !== 'staged' || entry.connection.revision !== expectedRevision) return false;
    entry.tokens = { ...tokens };
    entry.connection = revise(entry.connection, expectedRevision + 1, Date.now());
    return true;
  }

  async loadManagedFolderReservation(generationId: string): Promise<ManagedFolderReservation | null> {
    const entry = this.entries.get(generationId);
    if (entry?.connection.status !== 'staged') return null;
    return { revision: entry.connection.revision, ...entry.reservations };
  }

  async reserveManagedFolder(input: ReserveManagedFolder): Promise<ManagedFolderReservation | null> {
    const entry = this.entries.get(input.generationId);
    if (entry?.connection.status !== 'staged' || entry.connection.revision !== input.expectedRevision) return null;
    const key = reservationKey(input.role);
    const existing = entry.reservations[key];
    if (existing !== null) return existing === input.folderId ? { revision: entry.connection.revision, ...entry.reservations } : null;
    entry.reservations[key] = input.folderId;
    return { revision: entry.connection.revision, ...entry.reservations };
  }

  async activate(input: ActivateDriveConnection): Promise<{ active: DriveConnection; retiringId: string | null }> {
    const staged = this.entries.get(input.stagedId);
    if (staged?.connection.status !== 'staged' || staged.connection.revision !== input.expectedRevision) throw conflict('Staged Drive connection changed before activation');
    const current = [...this.entries.values()].find(({ connection }) => connection.status === 'active' || connection.status === 'reauth_required');
    if (current?.clientIdHash === staged.clientIdHash && current.connection.permissionId === input.permissionId && current.connection.installationId === staged.connection.installationId) {
      current.client = staged.client && { ...staged.client };
      current.tokens = staged.tokens && { ...staged.tokens };
      current.connection = current.connection.status === 'reauth_required'
        ? current.connection.activate({ ...input, nowMs: input.activatedAtMs })
        : revise(current.connection, current.connection.revision + 1, input.activatedAtMs);
      this.entries.delete(input.stagedId);
      return { active: current.connection, retiringId: null };
    }
    if (current) current.connection = current.connection.beginRetirement(input.activatedAtMs);
    staged.connection = staged.connection.activate({ ...input, nowMs: input.activatedAtMs });
    staged.receiptId = null;
    staged.expiresAtMs = null;
    return { active: staged.connection, retiringId: current?.connection.id ?? null };
  }

  async loadActive(): Promise<DriveConnection | null> {
    return [...this.entries.values()].find(({ connection }) => connection.status === 'active' || connection.status === 'reauth_required')?.connection ?? null;
  }

  async listStatusConnections(): Promise<readonly DriveStatusConnection[]> {
    return [...this.entries.values()].map(({ connection }) => ({ ...connection, errorCode: null }));
  }

  async readAlertCooldowns(generationId: string): Promise<Readonly<Record<string, number>> | null> {
    const entry = this.entries.get(generationId);
    return entry ? { ...entry.alertCooldowns } : null;
  }

  async compareAndSetAlertCooldowns(input: {
    generationId: string;
    expected: Readonly<Record<string, number>>;
    next: Readonly<Record<string, number>>;
  }): Promise<boolean> {
    const entry = this.entries.get(input.generationId);
    if (!entry || !sameCooldowns(entry.alertCooldowns, input.expected) || !validCooldowns(input.next)) return false;
    entry.alertCooldowns = { ...input.next };
    return true;
  }

  async readQuotaReclamation(generationId: string): Promise<DriveQuotaReclamationState | null> {
    const entry = this.entries.get(generationId);
    return entry ? { ...entry.quotaReclamation } : null;
  }

  async compareAndSetQuotaReclamation(input: CompareAndSetDriveQuotaReclamation): Promise<boolean> {
    const entry = this.entries.get(input.generationId);
    if (entry?.connection.status !== 'active'
      || !sameQuotaReclamation(entry.quotaReclamation, input.expected)
      || !validQuotaReclamation(input.next)) return false;
    entry.quotaReclamation = { ...input.next };
    return true;
  }

  async loadCredentials(generationId: string): Promise<{ client: DriveClientCredentials; tokens: OAuthTokenSet; revision: number } | null> {
    const entry = this.entries.get(generationId);
    if (!entry?.client || !entry.tokens) return null;
    return { client: { ...entry.client }, tokens: { ...entry.tokens }, revision: entry.connection.revision };
  }

  async replaceCredentials(generationId: string, expectedRevision: number, client: DriveClientCredentials, tokens: OAuthTokenSet): Promise<DriveConnection> {
    const entry = this.entries.get(generationId);
    if (entry?.connection.revision !== expectedRevision) throw conflict('Drive connection credentials changed before replacement');
    entry.client = { ...client };
    entry.tokens = { ...tokens };
    entry.connection = revise(entry.connection, expectedRevision + 1, Date.now());
    return entry.connection;
  }

  async mergeRefreshedTokens(input: MergeRefreshedTokens): Promise<boolean> {
    const entry = this.entries.get(input.generationId);
    if (!entry || (entry.connection.status !== 'active' && entry.connection.status !== 'reauth_required') || entry.connection.revision !== input.expectedRevision || !entry.tokens) return false;
    entry.tokens = { ...input.tokens, refreshToken: input.tokens.refreshToken ?? entry.tokens.refreshToken };
    entry.connection = revise(entry.connection, input.expectedRevision + 1, input.refreshedAtMs);
    return true;
  }

  async requireReauthorization(generationId: string, expectedRevision: number, _errorCode: string, atMs: number): Promise<boolean> {
    const entry = this.entries.get(generationId);
    if (entry?.connection.status !== 'active' || entry.connection.revision !== expectedRevision) return false;
    entry.connection = entry.connection.requireReauthorization(atMs);
    return true;
  }

  async beginDisconnect(generationId: string, expectedRevision: number): Promise<DriveConnection> {
    const entry = this.entries.get(generationId);
    if (entry?.connection.revision !== expectedRevision || (entry.connection.status !== 'active' && entry.connection.status !== 'reauth_required')) throw conflict('Drive connection changed before disconnection');
    entry.connection = entry.connection.beginDisconnect(Date.now());
    return entry.connection;
  }

  async completeSecretRemoval(generationId: string, terminal: DriveConnectionTerminalStatus, atMs: number, _revocationErrorCode: string | null): Promise<void> {
    const entry = this.entries.get(generationId);
    if (!entry) return;
    entry.connection = terminal === 'retired_unmanaged' ? entry.connection.retireUnmanaged(atMs) : entry.connection.disconnect(atMs);
    entry.client = null;
    entry.tokens = null;
  }

  async listInterruptedMaintenance(): Promise<readonly DriveConnection[]> {
    return [...this.entries.values()]
      .filter(({ connection }) => connection.status === 'retiring' || connection.status === 'disconnecting')
      .map(({ connection }) => connection);
  }

  async expireStaged(nowMs: number): Promise<readonly string[]> {
    const expired = [...this.entries.values()].filter(({ connection, expiresAtMs }) => connection.status === 'staged' && expiresAtMs !== null && expiresAtMs <= nowMs);
    for (const { connection } of expired) this.entries.delete(connection.id);
    return expired.map(({ connection }) => connection.id);
  }
}

function revise(connection: DriveConnection, revision: number, updatedAtMs: number): DriveConnection {
  return DriveConnection.restore({ ...connection, revision, updatedAtMs });
}

function emptyTokens(): OAuthTokenSet {
  return { accessToken: null, refreshToken: null, expiryDateMs: null, tokenType: null, scope: null };
}

function emptyReservations(): Omit<ManagedFolderReservation, 'revision'> {
  return { rootId: null, motionId: null, backupsId: null };
}

function emptyQuotaReclamation(): DriveQuotaReclamationState {
  return { windowStartedMs: null, reclaimedBytes: 0 };
}

function sameQuotaReclamation(
  left: DriveQuotaReclamationState,
  right: DriveQuotaReclamationState,
): boolean {
  return left.windowStartedMs === right.windowStartedMs && left.reclaimedBytes === right.reclaimedBytes;
}

function validQuotaReclamation(state: DriveQuotaReclamationState): boolean {
  return (state.windowStartedMs === null || (Number.isSafeInteger(state.windowStartedMs) && state.windowStartedMs >= 0))
    && Number.isSafeInteger(state.reclaimedBytes) && state.reclaimedBytes >= 0
    && (state.windowStartedMs !== null || state.reclaimedBytes === 0);
}

function sameCooldowns(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validCooldowns(cooldowns: Readonly<Record<string, number>>): boolean {
  return Object.entries(cooldowns).every(([key, value]) => key.length > 0 && Number.isSafeInteger(value) && value >= 0);
}

function reservationKey(role: ManagedFolderRole): keyof Omit<ManagedFolderReservation, 'revision'> {
  return role === 'root' ? 'rootId' : role === 'motion' ? 'motionId' : 'backupsId';
}

function conflict(message: string): DriveObjectConflictError {
  return new DriveObjectConflictError(message);
}
