import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../../database/database.module';
import { driveConnections } from '../../../database/schema';
import type {
  ActivateDriveConnection,
  CompareAndSetDriveQuotaReclamation,
  DriveClientCredentials,
  DriveConnectionTerminalStatus,
  DriveCredentialRepositoryPort,
  DriveStatusConnection,
  DriveQuotaReclamationState,
  MergeRefreshedTokens,
  ManagedFolderReservation,
  ManagedFolderRole,
  OAuthTokenSet,
  ReserveManagedFolder,
  StageDriveConnection,
} from '../../application/ports/drive-credential-repository.port';
import type { DriveCredentialErrorCode } from '../../application/ports/drive-credential-repository.port';
import {
  ARCHIVE_SECRET_CIPHER,
  type ArchiveSecretCipherPort,
  type ArchiveSecretEnvelope,
} from '../../application/ports/archive-secret-cipher.port';
import { DriveConnection, type DriveConnectionStatus } from '../../domain/drive-connection.entity';
import { DriveCredentialCorruptError } from '../../domain/errors/drive-credential-corrupt.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';

type ConnectionRow = typeof driveConnections.$inferSelect;
type ConnectionWriter = Pick<AppDatabase, 'delete' | 'insert' | 'select' | 'update'>;

/** Persistent encrypted Drive-credential generations with immediate fenced transitions. */
@Injectable()
export class DrizzleDriveCredentialRepository implements DriveCredentialRepositoryPort {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(ARCHIVE_SECRET_CIPHER) private readonly cipher: ArchiveSecretCipherPort,
  ) {}

  async stage(input: StageDriveConnection): Promise<DriveConnection> {
    const [clientEnvelope, tokenEnvelope] = await Promise.all([
      this.encryptClient(input.client, input.installationId, input.id),
      this.encryptTokens(emptyTokens(), input.installationId, input.id),
    ]);
    const connection = DriveConnection.stage({ id: input.id, installationId: input.installationId, nowMs: input.createdAtMs });
    try {
      this.db.insert(driveConnections).values({
        id: input.id,
        installationId: input.installationId,
        status: connection.status,
        revision: connection.revision,
        clientIdHash: input.clientIdHash,
        clientEnvelope: stringifyEnvelope(clientEnvelope),
        tokenEnvelope: stringifyEnvelope(tokenEnvelope),
        currentSlot: null,
        stagedSlot: 1,
        permissionId: null,
        email: null,
        displayName: null,
        rootFolderId: null,
        motionFolderId: null,
        backupsFolderId: null,
        adminUserId: input.adminUserId,
        chatId: input.chatId,
        workflowReceiptId: input.receiptId,
        workflowExpiresAt: input.expiresAtMs,
        createdAt: input.createdAtMs,
        updatedAt: input.createdAtMs,
        activatedAt: null,
        retiredAt: null,
        errorCode: null,
        alertCooldowns: {},
        quotaReclamationStartedAt: null,
        quotaReclaimedAt: null,
        quotaReclamationErrorCode: null,
      }).run();
    } catch (error) {
      if (isStagedSlotUniqueViolation(error)) throw conflict('A Drive setup is already staged');
      throw error;
    }
    return connection;
  }

  async loadStaged(receiptId: string, binding?: { generationId?: string; adminUserId: number; chatId: number }): Promise<DriveConnection | null> {
    const row = this.db.select().from(driveConnections)
      .where(and(
        eq(driveConnections.status, 'staged'),
        eq(driveConnections.workflowReceiptId, receiptId),
        ...(binding ? [
          eq(driveConnections.adminUserId, binding.adminUserId),
          eq(driveConnections.chatId, binding.chatId),
          ...(binding.generationId ? [eq(driveConnections.id, binding.generationId)] : []),
        ] : []),
      ))
      .get();
    return row ? toConnection(row) : null;
  }

  async discardStaged(id: string, receiptId: string): Promise<boolean> {
    const result = this.db.delete(driveConnections)
      .where(and(
        eq(driveConnections.id, id),
        eq(driveConnections.status, 'staged'),
        eq(driveConnections.workflowReceiptId, receiptId),
        eq(driveConnections.stagedSlot, 1),
      ))
      .run();
    return result.changes === 1;
  }

  async storeExchangedTokens(id: string, expectedRevision: number, tokens: OAuthTokenSet): Promise<boolean> {
    const row = this.db.select().from(driveConnections)
      .where(and(eq(driveConnections.id, id), eq(driveConnections.revision, expectedRevision), eq(driveConnections.status, 'staged')))
      .get();
    if (!row) return false;
    const tokenEnvelope = await this.encryptTokens(tokens, row.installationId, row.id);
    const updated = this.db.update(driveConnections)
      .set({ tokenEnvelope: stringifyEnvelope(tokenEnvelope), revision: expectedRevision + 1, updatedAt: Date.now() })
      .where(and(eq(driveConnections.id, id), eq(driveConnections.revision, expectedRevision), eq(driveConnections.status, 'staged')))
      .run();
    return updated.changes === 1;
  }

  async loadManagedFolderReservation(generationId: string): Promise<ManagedFolderReservation | null> {
    const row = this.db.select({
      revision: driveConnections.revision,
      rootId: driveConnections.rootFolderId,
      motionId: driveConnections.motionFolderId,
      backupsId: driveConnections.backupsFolderId,
    }).from(driveConnections).where(and(eq(driveConnections.id, generationId), eq(driveConnections.status, 'staged'))).get();
    return row ?? null;
  }

  async reserveManagedFolder(input: ReserveManagedFolder): Promise<ManagedFolderReservation | null> {
    const column = reservationColumn(input.role);
    const resultKey = reservationResultKey(input.role);
    return this.immediate((tx) => {
      const row = tx.select({
        revision: driveConnections.revision,
        rootId: driveConnections.rootFolderId,
        motionId: driveConnections.motionFolderId,
        backupsId: driveConnections.backupsFolderId,
      }).from(driveConnections).where(and(eq(driveConnections.id, input.generationId), eq(driveConnections.status, 'staged'), eq(driveConnections.revision, input.expectedRevision))).get();
      if (!row) return null;
      const existing = row[resultKey];
      if (existing !== null) return existing === input.folderId ? row : null;
      const updated = tx.update(driveConnections).set({ [column]: input.folderId, updatedAt: Date.now() })
        .where(and(
          eq(driveConnections.id, input.generationId),
          eq(driveConnections.status, 'staged'),
          eq(driveConnections.revision, input.expectedRevision),
          reservationIsEmpty(input.role),
        )).run();
      return updated.changes === 1 ? { ...row, [resultKey]: input.folderId } : null;
    });
  }

  async activate(input: ActivateDriveConnection): Promise<{ active: DriveConnection; retiringId: string | null }> {
    // A cipher envelope is bound to its generation ID. Re-encrypt before the
    // immediate transaction, then fence the transaction against both rows so a
    // retry, rather than a cross-generation envelope transplant, wins a race.
    const stagedForTransfer = this.db.select().from(driveConnections)
      .where(and(eq(driveConnections.id, input.stagedId), eq(driveConnections.status, 'staged'), eq(driveConnections.revision, input.expectedRevision)))
      .get();
    const currentForTransfer = this.db.select().from(driveConnections).where(eq(driveConnections.currentSlot, 1)).get();
    const transfer = stagedForTransfer && currentForTransfer?.clientIdHash === stagedForTransfer.clientIdHash
      && currentForTransfer.permissionId === input.permissionId
      && currentForTransfer.installationId === stagedForTransfer.installationId
      ? await this.reencryptForGeneration(stagedForTransfer, currentForTransfer)
      : null;
    return this.immediate((tx) => {
      const staged = tx.select().from(driveConnections)
        .where(and(eq(driveConnections.id, input.stagedId), eq(driveConnections.status, 'staged'), eq(driveConnections.revision, input.expectedRevision)))
        .get();
      if (!staged) throw conflict('Staged Drive connection changed before activation');
      const current = tx.select().from(driveConnections).where(eq(driveConnections.currentSlot, 1)).get();
      if (current?.clientIdHash === staged.clientIdHash && current.permissionId === input.permissionId && current.installationId === staged.installationId) {
        if (transfer?.stagedId !== staged.id || transfer.currentId !== current.id) {
          throw conflict('Drive connection changed before encrypted credential replacement');
        }
        const currentConnection = toConnection(current);
        const active = current.status === 'reauth_required'
          ? currentConnection.activate({ ...input, nowMs: input.activatedAtMs })
          : revise(currentConnection, current.revision + 1, input.activatedAtMs);
        const updated = tx.update(driveConnections).set({
          clientEnvelope: transfer.clientEnvelope,
          tokenEnvelope: transfer.tokenEnvelope,
          status: active.status,
          revision: active.revision,
          updatedAt: active.updatedAtMs,
          activatedAt: active.activatedAtMs,
          email: active.email,
          displayName: active.displayName,
          rootFolderId: active.folders?.rootId,
          motionFolderId: active.folders?.motionId,
          backupsFolderId: active.folders?.backupsId,
          errorCode: null,
        }).where(and(eq(driveConnections.id, current.id), eq(driveConnections.revision, current.revision), eq(driveConnections.currentSlot, 1))).run();
        if (updated.changes !== 1) throw conflict('Current Drive connection changed during activation');
        tx.delete(driveConnections).where(and(eq(driveConnections.id, staged.id), eq(driveConnections.stagedSlot, 1))).run();
        return { active, retiringId: null };
      }

      if (current) {
        const retiring = toConnection(current).beginRetirement(input.activatedAtMs);
        const retired = tx.update(driveConnections).set({
          status: retiring.status,
          currentSlot: null,
          revision: retiring.revision,
          updatedAt: retiring.updatedAtMs,
        }).where(and(eq(driveConnections.id, current.id), eq(driveConnections.revision, current.revision), eq(driveConnections.currentSlot, 1))).run();
        if (retired.changes !== 1) throw conflict('Current Drive connection changed during activation');
      }

      const active = toConnection(staged).activate({ ...input, nowMs: input.activatedAtMs });
      const activated = tx.update(driveConnections).set({
        status: active.status,
        revision: active.revision,
        currentSlot: 1,
        stagedSlot: null,
        permissionId: active.permissionId,
        email: active.email,
        displayName: active.displayName,
        rootFolderId: active.folders?.rootId,
        motionFolderId: active.folders?.motionId,
        backupsFolderId: active.folders?.backupsId,
        workflowReceiptId: null,
        workflowExpiresAt: null,
        updatedAt: active.updatedAtMs,
        activatedAt: active.activatedAtMs,
      }).where(and(eq(driveConnections.id, staged.id), eq(driveConnections.revision, staged.revision), eq(driveConnections.stagedSlot, 1))).run();
      if (activated.changes !== 1) throw conflict('Staged Drive connection changed during activation');
      return { active, retiringId: current?.id ?? null };
    });
  }

  async loadActive(): Promise<DriveConnection | null> {
    const row = this.db.select().from(driveConnections).where(eq(driveConnections.currentSlot, 1)).get();
    return row ? toConnection(row) : null;
  }

  async listStatusConnections(): Promise<readonly DriveStatusConnection[]> {
    return this.db.select({
      id: driveConnections.id,
      installationId: driveConnections.installationId,
      status: driveConnections.status,
      revision: driveConnections.revision,
      permissionId: driveConnections.permissionId,
      email: driveConnections.email,
      displayName: driveConnections.displayName,
      rootFolderId: driveConnections.rootFolderId,
      motionFolderId: driveConnections.motionFolderId,
      backupsFolderId: driveConnections.backupsFolderId,
      createdAt: driveConnections.createdAt,
      updatedAt: driveConnections.updatedAt,
      activatedAt: driveConnections.activatedAt,
      retiredAt: driveConnections.retiredAt,
      errorCode: driveConnections.errorCode,
    }).from(driveConnections).all().map(toStatusConnection);
  }

  async readAlertCooldowns(generationId: string): Promise<Readonly<Record<string, number>> | null> {
    const row = this.db.select({ alertCooldowns: driveConnections.alertCooldowns })
      .from(driveConnections).where(eq(driveConnections.id, generationId)).get();
    return row === undefined ? null : parseCooldowns(row.alertCooldowns);
  }

  async compareAndSetAlertCooldowns(input: {
    generationId: string;
    expected: Readonly<Record<string, number>>;
    next: Readonly<Record<string, number>>;
  }): Promise<boolean> {
    if (!validCooldowns(input.expected) || !validCooldowns(input.next)) return false;
    const result = this.db.update(driveConnections).set({ alertCooldowns: { ...input.next } })
      .where(and(
        eq(driveConnections.id, input.generationId),
        sql`${driveConnections.alertCooldowns} = ${JSON.stringify(input.expected)}`,
      )).run();
    return result.changes === 1;
  }

  async readQuotaReclamation(generationId: string): Promise<DriveQuotaReclamationState | null> {
    const row = this.db.select({
      windowStartedMs: driveConnections.quotaReclamationStartedAt,
      reclaimedBytes: driveConnections.quotaReclaimedAt,
    }).from(driveConnections).where(eq(driveConnections.id, generationId)).get();
    return row === undefined
      ? null
      : { windowStartedMs: row.windowStartedMs, reclaimedBytes: row.reclaimedBytes ?? 0 };
  }

  async compareAndSetQuotaReclamation(input: CompareAndSetDriveQuotaReclamation): Promise<boolean> {
    if (!validQuotaReclamation(input.expected) || !validQuotaReclamation(input.next)) return false;
    const expectedStarted = input.expected.windowStartedMs === null
      ? isNull(driveConnections.quotaReclamationStartedAt)
      : eq(driveConnections.quotaReclamationStartedAt, input.expected.windowStartedMs);
    const expectedBytes = input.expected.reclaimedBytes === 0
      ? or(isNull(driveConnections.quotaReclaimedAt), eq(driveConnections.quotaReclaimedAt, 0))
      : eq(driveConnections.quotaReclaimedAt, input.expected.reclaimedBytes);
    const result = this.db.update(driveConnections).set({
      quotaReclamationStartedAt: input.next.windowStartedMs,
      // This pre-existing integer column stores the durable reclaimed-byte total.
      quotaReclaimedAt: input.next.reclaimedBytes,
      quotaReclamationErrorCode: null,
    }).where(and(
      eq(driveConnections.id, input.generationId),
      eq(driveConnections.currentSlot, 1),
      eq(driveConnections.status, 'active'),
      expectedStarted,
      expectedBytes,
    )).run();
    return result.changes === 1;
  }

  async loadCredentials(generationId: string): Promise<{ client: DriveClientCredentials; tokens: OAuthTokenSet; revision: number } | null> {
    const row = this.db.select().from(driveConnections).where(eq(driveConnections.id, generationId)).get();
    if (!row?.clientEnvelope || !row.tokenEnvelope) return null;
    const [client, tokens] = await Promise.all([
      this.decryptClient(row.clientEnvelope, row.installationId, row.id),
      this.decryptTokens(row.tokenEnvelope, row.installationId, row.id),
    ]);
    return { client, tokens, revision: row.revision };
  }

  async replaceCredentials(generationId: string, expectedRevision: number, client: DriveClientCredentials, tokens: OAuthTokenSet): Promise<DriveConnection> {
    const row = this.db.select().from(driveConnections)
      .where(and(eq(driveConnections.id, generationId), eq(driveConnections.revision, expectedRevision)))
      .get();
    if (!row) throw conflict('Drive connection credentials changed before replacement');
    const [clientEnvelope, tokenEnvelope] = await Promise.all([
      this.encryptClient(client, row.installationId, row.id),
      this.encryptTokens(tokens, row.installationId, row.id),
    ]);
    const revision = expectedRevision + 1;
    const updatedAt = Date.now();
    const updated = this.db.update(driveConnections).set({
      clientEnvelope: stringifyEnvelope(clientEnvelope), tokenEnvelope: stringifyEnvelope(tokenEnvelope), revision, updatedAt,
    }).where(and(eq(driveConnections.id, generationId), eq(driveConnections.revision, expectedRevision))).run();
    if (updated.changes !== 1) throw conflict('Drive connection credentials changed during replacement');
    return toConnection({ ...row, clientEnvelope: stringifyEnvelope(clientEnvelope), tokenEnvelope: stringifyEnvelope(tokenEnvelope), revision, updatedAt });
  }

  async mergeRefreshedTokens(input: MergeRefreshedTokens): Promise<boolean> {
    const row = this.db.select().from(driveConnections)
      .where(and(eq(driveConnections.id, input.generationId), eq(driveConnections.revision, input.expectedRevision), eq(driveConnections.currentSlot, 1)))
      .get();
    if (!row?.tokenEnvelope) return false;
    const existing = await this.decryptTokens(row.tokenEnvelope, row.installationId, row.id);
    const tokens: OAuthTokenSet = { ...input.tokens, refreshToken: input.tokens.refreshToken ?? existing.refreshToken };
    const envelope = await this.encryptTokens(tokens, row.installationId, row.id);
    const updated = this.db.update(driveConnections).set({
      tokenEnvelope: stringifyEnvelope(envelope), revision: input.expectedRevision + 1, updatedAt: input.refreshedAtMs,
    }).where(and(eq(driveConnections.id, input.generationId), eq(driveConnections.revision, input.expectedRevision), eq(driveConnections.currentSlot, 1))).run();
    return updated.changes === 1;
  }

  async requireReauthorization(generationId: string, expectedRevision: number, errorCode: string, atMs: number): Promise<boolean> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveConnections).where(and(eq(driveConnections.id, generationId), eq(driveConnections.revision, expectedRevision), eq(driveConnections.currentSlot, 1))).get();
      if (row?.status !== 'active') return false;
      const reauthorizationRequired = toConnection(row).requireReauthorization(atMs);
      const updated = tx.update(driveConnections).set({
        status: reauthorizationRequired.status,
        revision: reauthorizationRequired.revision,
        updatedAt: reauthorizationRequired.updatedAtMs,
        errorCode: mapProviderErrorCode(errorCode),
      }).where(and(eq(driveConnections.id, generationId), eq(driveConnections.revision, expectedRevision), eq(driveConnections.currentSlot, 1), eq(driveConnections.status, 'active'))).run();
      return updated.changes === 1;
    });
  }

  async beginDisconnect(generationId: string, expectedRevision: number): Promise<DriveConnection> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveConnections).where(and(eq(driveConnections.id, generationId), eq(driveConnections.revision, expectedRevision), eq(driveConnections.currentSlot, 1))).get();
      if (!row) throw conflict('Drive connection changed before disconnection');
      const disconnecting = toConnection(row).beginDisconnect(Date.now());
      const updated = tx.update(driveConnections).set({
        status: disconnecting.status,
        currentSlot: null,
        revision: disconnecting.revision,
        updatedAt: disconnecting.updatedAtMs,
      }).where(and(eq(driveConnections.id, generationId), eq(driveConnections.revision, expectedRevision), eq(driveConnections.currentSlot, 1))).run();
      if (updated.changes !== 1) throw conflict('Drive connection changed during disconnection');
      return disconnecting;
    });
  }

  async completeSecretRemoval(generationId: string, terminal: DriveConnectionTerminalStatus, atMs: number, revocationErrorCode: string | null): Promise<void> {
    this.immediate((tx) => {
      const row = tx.select().from(driveConnections).where(eq(driveConnections.id, generationId)).get();
      if (!row) return;
      const connection = toConnection(row);
      const completed = terminal === 'retired_unmanaged' ? connection.retireUnmanaged(atMs) : connection.disconnect(atMs);
      const result = tx.update(driveConnections).set({
        status: completed.status,
        revision: completed.revision,
        updatedAt: completed.updatedAtMs,
        retiredAt: completed.retiredAtMs,
        clientEnvelope: null,
        tokenEnvelope: null,
        errorCode: revocationErrorCode === null ? null : mapProviderErrorCode(revocationErrorCode),
      }).where(and(eq(driveConnections.id, generationId), eq(driveConnections.status, row.status), eq(driveConnections.revision, row.revision))).run();
      if (result.changes !== 1) throw conflict('Drive connection changed during secret removal');
    });
  }

  async listInterruptedMaintenance(): Promise<readonly DriveConnection[]> {
    return this.db.select().from(driveConnections)
      .where(inArray(driveConnections.status, ['retiring', 'disconnecting']))
      .all()
      .map(toConnection);
  }

  async expireStaged(nowMs: number): Promise<readonly string[]> {
    return this.immediate((tx) => {
      const rows = tx.select({ id: driveConnections.id }).from(driveConnections)
        .where(and(eq(driveConnections.status, 'staged'), lte(driveConnections.workflowExpiresAt, nowMs)))
        .all();
      if (rows.length > 0) tx.delete(driveConnections).where(inArray(driveConnections.id, rows.map(({ id }) => id))).run();
      return rows.map(({ id }) => id);
    });
  }

  private async encryptClient(value: DriveClientCredentials, installationId: string, rowId: string): Promise<ArchiveSecretEnvelope> {
    assertClient(value);
    return this.cipher.encrypt(Buffer.from(JSON.stringify(value), 'utf8'), { installationId, rowId, kind: 'oauth-client', schemaVersion: 1 });
  }

  private async encryptTokens(value: OAuthTokenSet, installationId: string, rowId: string): Promise<ArchiveSecretEnvelope> {
    assertTokens(value);
    return this.cipher.encrypt(Buffer.from(JSON.stringify(value), 'utf8'), { installationId, rowId, kind: 'oauth-token', schemaVersion: 1 });
  }

  private async decryptClient(value: string, installationId: string, rowId: string): Promise<DriveClientCredentials> {
    const parsed = parseJson(await this.cipher.decrypt(parseEnvelope(value), { installationId, rowId, kind: 'oauth-client', schemaVersion: 1 }));
    assertClient(parsed);
    return parsed;
  }

  private async decryptTokens(value: string, installationId: string, rowId: string): Promise<OAuthTokenSet> {
    const parsed = parseJson(await this.cipher.decrypt(parseEnvelope(value), { installationId, rowId, kind: 'oauth-token', schemaVersion: 1 }));
    assertTokens(parsed);
    return parsed;
  }

  private async reencryptForGeneration(staged: ConnectionRow, current: ConnectionRow): Promise<{
    stagedId: string;
    currentId: string;
    clientEnvelope: string;
    tokenEnvelope: string;
  }> {
    if (!staged.clientEnvelope || !staged.tokenEnvelope) throw new DriveCredentialCorruptError();
    const [client, tokens] = await Promise.all([
      this.decryptClient(staged.clientEnvelope, staged.installationId, staged.id),
      this.decryptTokens(staged.tokenEnvelope, staged.installationId, staged.id),
    ]);
    const [clientEnvelope, tokenEnvelope] = await Promise.all([
      this.encryptClient(client, current.installationId, current.id),
      this.encryptTokens(tokens, current.installationId, current.id),
    ]);
    return {
      stagedId: staged.id,
      currentId: current.id,
      clientEnvelope: stringifyEnvelope(clientEnvelope),
      tokenEnvelope: stringifyEnvelope(tokenEnvelope),
    };
  }

  private immediate<T>(operation: (tx: ConnectionWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

function toConnection(row: ConnectionRow): DriveConnection {
  return DriveConnection.restore({
    id: row.id,
    installationId: row.installationId,
    status: row.status as DriveConnectionStatus,
    revision: row.revision,
    permissionId: row.permissionId,
    email: row.email,
    displayName: row.displayName,
    folders: row.rootFolderId && row.motionFolderId && row.backupsFolderId
      ? { rootId: row.rootFolderId, motionId: row.motionFolderId, backupsId: row.backupsFolderId }
      : null,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
    activatedAtMs: row.activatedAt,
    retiredAtMs: row.retiredAt,
  });
}

function toStatusConnection(row: Pick<ConnectionRow,
  'id' | 'installationId' | 'status' | 'revision' | 'permissionId' | 'email' |
  'displayName' | 'rootFolderId' | 'motionFolderId' | 'backupsFolderId' |
  'createdAt' | 'updatedAt' | 'activatedAt' | 'retiredAt' | 'errorCode'
>): DriveStatusConnection {
  return { ...toConnection(row as ConnectionRow), errorCode: row.errorCode };
}

function emptyTokens(): OAuthTokenSet {
  return { accessToken: null, refreshToken: null, expiryDateMs: null, tokenType: null, scope: null };
}

function parseCooldowns(value: unknown): Record<string, number> {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cooldowns = Object.fromEntries(Object.entries(value).filter(
    ([key, entry]) => key.length > 0 && Number.isSafeInteger(entry) && entry >= 0,
  ));
  return cooldowns;
}

function validCooldowns(cooldowns: Readonly<Record<string, number>>): boolean {
  return Object.entries(cooldowns).every(([key, value]) => key.length > 0 && Number.isSafeInteger(value) && value >= 0);
}

function revise(connection: DriveConnection, revision: number, updatedAtMs: number): DriveConnection {
  return DriveConnection.restore({ ...connection, revision, updatedAtMs });
}

function reservationColumn(role: ManagedFolderRole): 'rootFolderId' | 'motionFolderId' | 'backupsFolderId' {
  return role === 'root' ? 'rootFolderId' : role === 'motion' ? 'motionFolderId' : 'backupsFolderId';
}

function reservationResultKey(role: ManagedFolderRole): 'rootId' | 'motionId' | 'backupsId' {
  return role === 'root' ? 'rootId' : role === 'motion' ? 'motionId' : 'backupsId';
}

function reservationIsEmpty(role: ManagedFolderRole) {
  return role === 'root'
    ? isNull(driveConnections.rootFolderId)
    : role === 'motion'
      ? isNull(driveConnections.motionFolderId)
      : isNull(driveConnections.backupsFolderId);
}

function stringifyEnvelope(value: ArchiveSecretEnvelope): string {
  return JSON.stringify(value);
}

function parseEnvelope(value: string): ArchiveSecretEnvelope {
  const parsed = parseJson(Buffer.from(value, 'utf8'));
  if (!isEnvelope(parsed)) {
    throw new DriveCredentialCorruptError();
  }
  return parsed;
}

function parseJson(value: Buffer): unknown {
  try {
    return JSON.parse(value.toString('utf8'));
  } catch {
    throw new DriveCredentialCorruptError();
  }
}

function assertClient(value: unknown): asserts value is DriveClientCredentials {
  if (!isRecord(value) || typeof value.clientId !== 'string' || value.clientId.length === 0 || typeof value.clientSecret !== 'string' || value.clientSecret.length === 0) {
    throw new DriveCredentialCorruptError();
  }
}

function assertTokens(value: unknown): asserts value is OAuthTokenSet {
  if (!isRecord(value)
    || !isNullableString(value.accessToken)
    || !isNullableString(value.refreshToken)
    || !isNullableString(value.tokenType)
    || !isNullableString(value.scope)
    || !(value.expiryDateMs === null || (typeof value.expiryDateMs === 'number' && Number.isSafeInteger(value.expiryDateMs) && value.expiryDateMs >= 0))) {
    throw new DriveCredentialCorruptError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is ArchiveSecretEnvelope {
  return isRecord(value)
    && value.version === 1
    && typeof value.iv === 'string'
    && typeof value.ciphertext === 'string'
    && typeof value.authTag === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function mapProviderErrorCode(value: unknown): DriveCredentialErrorCode {
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'authorization_required':
    case 'invalid_grant':
    case 'invalid_token':
    case 'invalid_credentials':
      return 'authorization_required';
    case 'access_denied':
    case 'insufficient_permissions':
    case 'forbidden':
      return 'access_denied';
    case 'temporarily_unavailable':
    case 'server_error':
    case 'service_unavailable':
      return 'temporarily_unavailable';
    case 'rate_limited':
    case 'rate_limit_exceeded':
    case 'resource_exhausted':
      return 'rate_limited';
    case 'network_unavailable':
    case 'network_error':
    case 'econnreset':
    case 'etimedout':
      return 'network_unavailable';
    default:
      return 'unknown';
  }
}

function isStagedSlotUniqueViolation(error: unknown): boolean {
  return isRecord(error)
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    && typeof error.message === 'string'
    && error.message.includes('drive_connections.staged_slot');
}

function validQuotaReclamation(state: DriveQuotaReclamationState): boolean {
  return (state.windowStartedMs === null || (Number.isSafeInteger(state.windowStartedMs) && state.windowStartedMs >= 0))
    && Number.isSafeInteger(state.reclaimedBytes) && state.reclaimedBytes >= 0
    && (state.windowStartedMs !== null || state.reclaimedBytes === 0);
}

function conflict(message: string): DriveObjectConflictError {
  return new DriveObjectConflictError(message);
}
