import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { homeSessions } from '../../database/schema';
import { encodeHomeView, parseHomeView } from '../domain/home-session';
import type {
  HomeIdentity,
  HomeReservation,
  HomeView,
  PromoteResult,
  ReserveEditResult,
  ValidateHomeResult,
} from '../domain/home-session';
import type { HomeSessionStorePort } from '../domain/ports/home-session-store.port';

type SessionRow = typeof homeSessions.$inferSelect;
type SessionWriter = Pick<AppDatabase, 'delete' | 'insert' | 'select' | 'update'>;

const HOME_TOKEN = /^[A-Za-z0-9_-]{16}$/;

function sameIdentity(left: HomeIdentity, right: HomeIdentity): boolean {
  return left.userId === right.userId
    && left.chatId === right.chatId
    && left.messageId === right.messageId
    && left.token === right.token
    && left.revision === right.revision;
}

function sameView(left: HomeView, right: HomeView): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameReservation(left: HomeReservation, right: HomeReservation): boolean {
  return left.kind === right.kind
    && left.userId === right.userId
    && left.chatId === right.chatId
    && left.messageId === right.messageId
    && left.token === right.token
    && left.revision === right.revision
    && sameView(left.view, right.view)
    && left.expiresAt.getTime() === right.expiresAt.getTime();
}

function pendingValues(reservation: HomeReservation) {
  const encoded = encodeHomeView(reservation.view);
  return {
    pendingKind: reservation.kind,
    pendingMessageId: reservation.messageId,
    pendingToken: reservation.token,
    pendingRevision: reservation.revision,
    pendingView: reservation.view.kind,
    pendingSensorPage: encoded.sensorPage,
    pendingViewPayload: encoded.payload,
    pendingChecking: encoded.checking === null ? null : Number(encoded.checking),
    pendingExpiresAt: reservation.expiresAt,
  };
}

function activeValues(active: HomeIdentity, view: HomeView) {
  const encoded = encodeHomeView(view);
  return {
    activeMessageId: active.messageId,
    activeToken: active.token,
    activeRevision: active.revision,
    activeView: view.kind,
    activeSensorPage: encoded.sensorPage,
    activeViewPayload: encoded.payload,
    activeChecking: encoded.checking === null ? null : Number(encoded.checking),
  };
}

function clearPendingValues() {
  return {
    pendingKind: null,
    pendingMessageId: null,
    pendingToken: null,
    pendingRevision: null,
    pendingView: null,
    pendingSensorPage: null,
    pendingViewPayload: null,
    pendingChecking: null,
    pendingExpiresAt: null,
  };
}

function activeOf(row: SessionRow): { identity: HomeIdentity; view: HomeView } | null {
  if (
    row.activeMessageId === null
    || row.activeToken === null
    || row.activeRevision === null
    || row.activeView === null
  ) return null;
  if (!isHomeToken(row.activeToken) || !isPositiveSafeInteger(row.activeMessageId) || !isPositiveSafeInteger(row.activeRevision)) return null;
  const checking = parseStoredBoolean(row.activeChecking);
  if (checking === undefined) return null;
  const view = parseHomeView(row.activeView, row.activeSensorPage, row.activeViewPayload, checking);
  return view ? {
    identity: { userId: row.userId, chatId: row.chatId, messageId: row.activeMessageId, token: row.activeToken, revision: row.activeRevision },
    view,
  } : null;
}

function pendingOf(row: SessionRow): HomeReservation | null {
  if (
    (row.pendingKind !== 'new' && row.pendingKind !== 'edit')
    || row.pendingToken === null
    || row.pendingRevision === null
    || row.pendingView === null
    || row.pendingExpiresAt === null
  ) return null;
  if (!isHomeToken(row.pendingToken) || !isPositiveSafeInteger(row.pendingRevision)) return null;
  if ((row.pendingKind === 'edit' && !isPositiveSafeInteger(row.pendingMessageId))
    || (row.pendingKind === 'new' && row.pendingMessageId !== null)) return null;
  const checking = parseStoredBoolean(row.pendingChecking);
  if (checking === undefined) return null;
  const view = parseHomeView(row.pendingView, row.pendingSensorPage, row.pendingViewPayload, checking);
  return view ? {
    kind: row.pendingKind,
    userId: row.userId,
    chatId: row.chatId,
    messageId: row.pendingMessageId,
    token: row.pendingToken,
    revision: row.pendingRevision,
    view,
    expiresAt: row.pendingExpiresAt,
  } : null;
}

function hasPendingValues(row: SessionRow): boolean {
  return row.pendingKind !== null
    || row.pendingMessageId !== null
    || row.pendingToken !== null
    || row.pendingRevision !== null
    || row.pendingView !== null
    || row.pendingSensorPage !== null
    || row.pendingViewPayload !== null
    || row.pendingChecking !== null
    || row.pendingExpiresAt !== null;
}

function isHomeToken(value: unknown): value is string {
  return typeof value === 'string' && HOME_TOKEN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** `undefined` marks a non-canonical raw SQLite boolean. */
function parseStoredBoolean(value: number | null): boolean | null | undefined {
  if (value === null) return null;
  if (value === 0) return false;
  if (value === 1) return true;
  return undefined;
}

function isExpired(reservation: HomeReservation, now: Date): boolean {
  return now.getTime() >= reservation.expiresAt.getTime();
}

/** Persistent SQLite adapter; all authority transitions are composite-key CAS transactions. */
@Injectable()
export class DrizzleHomeSessionStore implements HomeSessionStorePort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async reserveNew(input: {
    userId: number;
    chatId: number;
    token: string;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<HomeReservation> {
    return this.immediate((tx) => {
      const reservation: HomeReservation = {
        kind: 'new', userId: input.userId, chatId: input.chatId, messageId: null,
        token: input.token, revision: 1, view: input.view, expiresAt: input.expiresAt,
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const row = this.find(tx, input.userId, input.chatId);
        const result = row
          ? tx.update(homeSessions)
            .set({ ...pendingValues(reservation), updatedAt: input.now })
            .where(this.rowGuard(row))
            .run()
          : tx.insert(homeSessions).values({
            userId: input.userId,
            chatId: input.chatId,
            ...pendingValues(reservation),
            updatedAt: input.now,
          }).run();
        if (result.changes === 1) return reservation;
      }
      throw new Error('Home session reservation compare-and-swap failed');
    });
  }

  async reserveEdit(input: {
    active: HomeIdentity;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<ReserveEditResult> {
    return this.immediate((tx) => {
      const row = this.find(tx, input.active.userId, input.active.chatId);
      if (!row) return { kind: 'closed' };
      const active = activeOf(row);
      if (!active) return { kind: 'closed' };
      if (!sameIdentity(active.identity, input.active)) return { kind: 'stale' };
      const pending = pendingOf(row);
      if (hasPendingValues(row) && !pending) return { kind: 'closed' };
      const highestRevision = Math.max(active.identity.revision, pending && !isExpired(pending, input.now) ? pending.revision : 0);
      if (highestRevision >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Home session revision cannot exceed Number.MAX_SAFE_INTEGER');
      }
      const reservation: HomeReservation = {
        kind: 'edit',
        ...active.identity,
        revision: highestRevision + 1,
        view: input.view,
        expiresAt: input.expiresAt,
      };
      const result = tx.update(homeSessions)
        .set({ ...pendingValues(reservation), updatedAt: input.now })
        .where(this.rowGuard(row))
        .run();
      if (result.changes === 1) return { kind: 'reserved', reservation };
      const reread = this.find(tx, input.active.userId, input.active.chatId);
      if (!reread || !activeOf(reread)) return { kind: 'closed' };
      return { kind: 'stale' };
    });
  }

  async promoteNew(reservation: HomeReservation, messageId: number, now: Date): Promise<PromoteResult> {
    if (reservation.kind !== 'new') return { kind: 'lost' };
    return this.immediate((tx) => {
      const row = this.find(tx, reservation.userId, reservation.chatId);
      if (!row) return { kind: 'lost' };
      const pending = pendingOf(row);
      if (!pending || isExpired(pending, now) || !sameReservation(pending, reservation)) {
        if (pending && isExpired(pending, now)) this.expirePending(tx, row, now);
        return { kind: 'lost' };
      }
      const previous = activeOf(row)?.identity ?? null;
      const active: HomeIdentity = {
        userId: reservation.userId,
        chatId: reservation.chatId,
        messageId,
        token: reservation.token,
        revision: reservation.revision,
      };
      const result = tx.update(homeSessions)
        .set({ ...activeValues(active, reservation.view), ...clearPendingValues(), updatedAt: now })
        .where(this.rowGuard(row))
        .run();
      if (result.changes === 1) return { kind: 'promoted', active, previous };
      this.find(tx, reservation.userId, reservation.chatId);
      return { kind: 'lost' };
    });
  }

  async promoteEdit(reservation: HomeReservation, now: Date): Promise<PromoteResult> {
    if (reservation.kind !== 'edit' || reservation.messageId === null) return { kind: 'lost' };
    const messageId = reservation.messageId;
    return this.immediate((tx) => {
      const row = this.find(tx, reservation.userId, reservation.chatId);
      if (!row) return { kind: 'lost' };
      const pending = pendingOf(row);
      if (!pending || isExpired(pending, now) || !sameReservation(pending, reservation)) {
        if (pending && isExpired(pending, now)) this.expirePending(tx, row, now);
        return { kind: 'lost' };
      }
      const previous = activeOf(row)?.identity ?? null;
      const active: HomeIdentity = {
        userId: reservation.userId, chatId: reservation.chatId, messageId,
        token: reservation.token, revision: reservation.revision,
      };
      const result = tx.update(homeSessions)
        .set({ ...activeValues(active, reservation.view), ...clearPendingValues(), updatedAt: now })
        .where(this.rowGuard(row))
        .run();
      if (result.changes === 1) return { kind: 'promoted', active, previous };
      this.find(tx, reservation.userId, reservation.chatId);
      return { kind: 'lost' };
    });
  }

  async abandon(reservation: HomeReservation): Promise<void> {
    this.immediate((tx) => {
      const row = this.find(tx, reservation.userId, reservation.chatId);
      if (!row) return;
      const pending = pendingOf(row);
      if (!pending || !sameReservation(pending, reservation)) return;
      const result = !activeOf(row)
        ? tx.delete(homeSessions).where(this.rowGuard(row)).run()
        : tx.update(homeSessions)
          .set(clearPendingValues())
          .where(this.rowGuard(row))
          .run();
      if (result.changes === 0) this.find(tx, reservation.userId, reservation.chatId);
    });
  }

  async validate(input: HomeIdentity & { now: Date }): Promise<ValidateHomeResult> {
    return this.immediate((tx) => {
      const row = this.find(tx, input.userId, input.chatId);
      if (!row) return { kind: 'closed' };
      const active = activeOf(row);
      const pending = pendingOf(row);
      if (hasPendingValues(row) && !pending) return { kind: 'closed' };
      const expired = pending !== null && isExpired(pending, input.now);
      if (!active) {
        if (expired) {
          const result = this.expirePending(tx, row, input.now);
          if (result.changes === 0) return this.validateAfterCasMiss(tx, input);
        }
        return { kind: 'closed' };
      }
      if (expired) {
        const result = this.expirePending(tx, row, input.now);
        if (result.changes === 0) return this.validateAfterCasMiss(tx, input);
        if (!sameIdentity(active.identity, input)) return { kind: 'stale' };
        return { kind: 'accepted', active: active.identity, view: active.view };
      }
      if (pending?.kind === 'edit' && pending.messageId !== null) {
        const pendingIdentity: HomeIdentity = {
          userId: pending.userId, chatId: pending.chatId,
          messageId: pending.messageId, token: pending.token, revision: pending.revision,
        };
        if (sameIdentity(pendingIdentity, input)) {
          const result = tx.update(homeSessions)
            .set({ ...activeValues(pendingIdentity, pending.view), ...clearPendingValues(), updatedAt: input.now })
            .where(this.rowGuard(row))
            .run();
          if (result.changes === 1) return { kind: 'accepted', active: pendingIdentity, view: pending.view };
          return this.validateAfterCasMiss(tx, input);
        }
      }
      if (!sameIdentity(active.identity, input)) return { kind: 'stale' };
      if (pending?.kind === 'edit') return { kind: 'updating' };
      return { kind: 'accepted', active: active.identity, view: active.view };
    });
  }

  async close(input: HomeIdentity & { now: Date }): Promise<'closed' | 'stale'> {
    return this.immediate((tx) => {
      const row = this.find(tx, input.userId, input.chatId);
      const active = row && activeOf(row);
      if (!row || !active || !sameIdentity(active.identity, input)) return 'stale';
      const result = tx.delete(homeSessions).where(this.rowGuard(row)).run();
      if (result.changes === 1) return 'closed';
      this.find(tx, input.userId, input.chatId);
      return 'stale';
    });
  }

  private find(db: SessionWriter, userId: number, chatId: number): SessionRow | undefined {
    return db.select().from(homeSessions).where(this.key(userId, chatId)).get();
  }

  private key(userId: number, chatId: number) {
    return and(eq(homeSessions.userId, userId), eq(homeSessions.chatId, chatId));
  }

  private rowGuard(row: SessionRow) {
    return and(
      this.key(row.userId, row.chatId),
      row.activeMessageId === null ? isNull(homeSessions.activeMessageId) : eq(homeSessions.activeMessageId, row.activeMessageId),
      row.activeToken === null ? isNull(homeSessions.activeToken) : eq(homeSessions.activeToken, row.activeToken),
      row.activeRevision === null ? isNull(homeSessions.activeRevision) : eq(homeSessions.activeRevision, row.activeRevision),
      row.activeView === null ? isNull(homeSessions.activeView) : eq(homeSessions.activeView, row.activeView),
      row.activeSensorPage === null ? isNull(homeSessions.activeSensorPage) : eq(homeSessions.activeSensorPage, row.activeSensorPage),
      row.activeViewPayload === null ? isNull(homeSessions.activeViewPayload) : eq(homeSessions.activeViewPayload, row.activeViewPayload),
      row.activeChecking === null ? isNull(homeSessions.activeChecking) : eq(homeSessions.activeChecking, row.activeChecking),
      row.pendingKind === null ? isNull(homeSessions.pendingKind) : eq(homeSessions.pendingKind, row.pendingKind),
      row.pendingMessageId === null ? isNull(homeSessions.pendingMessageId) : eq(homeSessions.pendingMessageId, row.pendingMessageId),
      row.pendingToken === null ? isNull(homeSessions.pendingToken) : eq(homeSessions.pendingToken, row.pendingToken),
      row.pendingRevision === null ? isNull(homeSessions.pendingRevision) : eq(homeSessions.pendingRevision, row.pendingRevision),
      row.pendingView === null ? isNull(homeSessions.pendingView) : eq(homeSessions.pendingView, row.pendingView),
      row.pendingSensorPage === null ? isNull(homeSessions.pendingSensorPage) : eq(homeSessions.pendingSensorPage, row.pendingSensorPage),
      row.pendingViewPayload === null ? isNull(homeSessions.pendingViewPayload) : eq(homeSessions.pendingViewPayload, row.pendingViewPayload),
      row.pendingChecking === null ? isNull(homeSessions.pendingChecking) : eq(homeSessions.pendingChecking, row.pendingChecking),
      row.pendingExpiresAt === null ? isNull(homeSessions.pendingExpiresAt) : eq(homeSessions.pendingExpiresAt, row.pendingExpiresAt),
    );
  }

  private immediate<T>(operation: (tx: SessionWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }

  private validateAfterCasMiss(
    tx: SessionWriter,
    input: HomeIdentity & { now: Date },
  ): ValidateHomeResult {
    const row = this.find(tx, input.userId, input.chatId);
    if (!row) return { kind: 'closed' };
    const active = activeOf(row);
    if (!active) return { kind: 'closed' };
    if (!sameIdentity(active.identity, input)) return { kind: 'stale' };
    const pending = pendingOf(row);
    if (hasPendingValues(row) && !pending) return { kind: 'closed' };
    return pending?.kind === 'edit'
      ? { kind: 'updating' }
      : { kind: 'accepted', active: active.identity, view: active.view };
  }

  private expirePending(tx: SessionWriter, row: SessionRow, now: Date) {
    if (!activeOf(row)) {
      return tx.delete(homeSessions).where(this.rowGuard(row)).run();
    }
    return tx.update(homeSessions)
      .set({ ...clearPendingValues(), updatedAt: now })
      .where(this.rowGuard(row))
      .run();
  }
}
