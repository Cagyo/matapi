import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { homeSessions } from '../../database/schema';
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

function sameIdentity(left: HomeIdentity, right: HomeIdentity): boolean {
  return left.userId === right.userId
    && left.chatId === right.chatId
    && left.messageId === right.messageId
    && left.token === right.token
    && left.revision === right.revision;
}

function sameView(left: HomeView, right: HomeView): boolean {
  return left.kind === right.kind
    && left.checking === right.checking
    && (left.kind !== 'sensors' || right.kind !== 'sensors' || left.page === right.page);
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
  return {
    pendingKind: reservation.kind,
    pendingMessageId: reservation.messageId,
    pendingToken: reservation.token,
    pendingRevision: reservation.revision,
    pendingView: reservation.view.kind,
    pendingSensorPage: reservation.view.kind === 'sensors' ? reservation.view.page : null,
    pendingChecking: reservation.view.checking,
    pendingExpiresAt: reservation.expiresAt,
  };
}

function activeValues(active: HomeIdentity, view: HomeView) {
  return {
    activeMessageId: active.messageId,
    activeToken: active.token,
    activeRevision: active.revision,
    activeView: view.kind,
    activeSensorPage: view.kind === 'sensors' ? view.page : null,
    activeChecking: view.checking,
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
    || row.activeChecking === null
  ) return null;
  if (row.activeView === 'home') {
    return {
      identity: { userId: row.userId, chatId: row.chatId, messageId: row.activeMessageId, token: row.activeToken, revision: row.activeRevision },
      view: { kind: 'home', checking: row.activeChecking },
    };
  }
  if (row.activeView === 'sensors' && row.activeSensorPage !== null) {
    return {
      identity: { userId: row.userId, chatId: row.chatId, messageId: row.activeMessageId, token: row.activeToken, revision: row.activeRevision },
      view: { kind: 'sensors', page: row.activeSensorPage, checking: row.activeChecking },
    };
  }
  return null;
}

function pendingOf(row: SessionRow): HomeReservation | null {
  if (
    (row.pendingKind !== 'new' && row.pendingKind !== 'edit')
    || row.pendingToken === null
    || row.pendingRevision === null
    || row.pendingView === null
    || row.pendingChecking === null
    || row.pendingExpiresAt === null
  ) return null;
  if (row.pendingKind === 'edit' && row.pendingMessageId === null) return null;
  if (row.pendingView === 'home') {
    return {
      kind: row.pendingKind,
      userId: row.userId,
      chatId: row.chatId,
      messageId: row.pendingMessageId,
      token: row.pendingToken,
      revision: row.pendingRevision,
      view: { kind: 'home', checking: row.pendingChecking },
      expiresAt: row.pendingExpiresAt,
    };
  }
  if (row.pendingView === 'sensors' && row.pendingSensorPage !== null) {
    return {
      kind: row.pendingKind,
      userId: row.userId,
      chatId: row.chatId,
      messageId: row.pendingMessageId,
      token: row.pendingToken,
      revision: row.pendingRevision,
      view: { kind: 'sensors', page: row.pendingSensorPage, checking: row.pendingChecking },
      expiresAt: row.pendingExpiresAt,
    };
  }
  return null;
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
    return this.db.transaction((tx) => {
      const existing = this.find(tx, input.userId, input.chatId);
      const reservation: HomeReservation = {
        kind: 'new', userId: input.userId, chatId: input.chatId, messageId: null,
        token: input.token, revision: 1, view: input.view, expiresAt: input.expiresAt,
      };
      if (!existing) {
        tx.insert(homeSessions).values({
          userId: input.userId,
          chatId: input.chatId,
          ...pendingValues(reservation),
          updatedAt: input.now,
        }).run();
      } else {
        tx.update(homeSessions)
          .set({ ...pendingValues(reservation), updatedAt: input.now })
          .where(this.key(input.userId, input.chatId))
          .run();
      }
      return reservation;
    });
  }

  async reserveEdit(input: {
    active: HomeIdentity;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<ReserveEditResult> {
    return this.db.transaction((tx) => {
      const row = this.find(tx, input.active.userId, input.active.chatId);
      if (!row) return { kind: 'closed' };
      const active = activeOf(row);
      if (!active) return { kind: 'closed' };
      if (!sameIdentity(active.identity, input.active)) return { kind: 'stale' };
      const pending = pendingOf(row);
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
      tx.update(homeSessions)
        .set({ ...pendingValues(reservation), updatedAt: input.now })
        .where(this.key(input.active.userId, input.active.chatId))
        .run();
      return { kind: 'reserved', reservation };
    });
  }

  async promoteNew(reservation: HomeReservation, messageId: number, now: Date): Promise<PromoteResult> {
    if (reservation.kind !== 'new') return { kind: 'lost' };
    return this.db.transaction((tx) => {
      const row = this.find(tx, reservation.userId, reservation.chatId);
      if (!row) return { kind: 'lost' };
      const pending = pendingOf(row);
      if (!pending || isExpired(pending, now) || !sameReservation(pending, reservation)) {
        if (pending && isExpired(pending, now)) this.clearPending(tx, reservation.userId, reservation.chatId, now);
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
      tx.update(homeSessions)
        .set({ ...activeValues(active, reservation.view), ...clearPendingValues(), updatedAt: now })
        .where(this.key(reservation.userId, reservation.chatId))
        .run();
      return { kind: 'promoted', active, previous };
    });
  }

  async promoteEdit(reservation: HomeReservation, now: Date): Promise<PromoteResult> {
    if (reservation.kind !== 'edit' || reservation.messageId === null) return { kind: 'lost' };
    const messageId = reservation.messageId;
    return this.db.transaction((tx) => {
      const row = this.find(tx, reservation.userId, reservation.chatId);
      if (!row) return { kind: 'lost' };
      const pending = pendingOf(row);
      if (!pending || isExpired(pending, now) || !sameReservation(pending, reservation)) {
        if (pending && isExpired(pending, now)) this.clearPending(tx, reservation.userId, reservation.chatId, now);
        return { kind: 'lost' };
      }
      const previous = activeOf(row)?.identity ?? null;
      const active: HomeIdentity = {
        userId: reservation.userId, chatId: reservation.chatId, messageId,
        token: reservation.token, revision: reservation.revision,
      };
      tx.update(homeSessions)
        .set({ ...activeValues(active, reservation.view), ...clearPendingValues(), updatedAt: now })
        .where(this.key(reservation.userId, reservation.chatId))
        .run();
      return { kind: 'promoted', active, previous };
    });
  }

  async abandon(reservation: HomeReservation): Promise<void> {
    this.db.transaction((tx) => {
      const row = this.find(tx, reservation.userId, reservation.chatId);
      if (!row) return;
      const pending = pendingOf(row);
      if (!pending || !sameReservation(pending, reservation)) return;
      if (!activeOf(row)) {
        tx.delete(homeSessions).where(this.key(reservation.userId, reservation.chatId)).run();
      } else {
        tx.update(homeSessions)
          .set(clearPendingValues())
          .where(this.key(reservation.userId, reservation.chatId))
          .run();
      }
    });
  }

  async validate(input: HomeIdentity & { now: Date }): Promise<ValidateHomeResult> {
    return this.db.transaction((tx) => {
      const row = this.find(tx, input.userId, input.chatId);
      if (!row) return { kind: 'closed' };
      const active = activeOf(row);
      const pending = pendingOf(row);
      const expired = pending !== null && isExpired(pending, input.now);
      const currentPending = expired ? null : pending;
      if (!active) {
        if (expired) this.clearPending(tx, input.userId, input.chatId, input.now);
        return { kind: 'closed' };
      }
      if (currentPending?.kind === 'edit' && currentPending.messageId !== null) {
        const pendingIdentity: HomeIdentity = {
          userId: currentPending.userId, chatId: currentPending.chatId,
          messageId: currentPending.messageId, token: currentPending.token, revision: currentPending.revision,
        };
        if (sameIdentity(pendingIdentity, input)) {
          tx.update(homeSessions)
            .set({ ...activeValues(pendingIdentity, currentPending.view), ...clearPendingValues(), updatedAt: input.now })
            .where(this.key(input.userId, input.chatId))
            .run();
          return { kind: 'accepted', active: pendingIdentity, view: currentPending.view };
        }
      }
      if (expired) this.clearPending(tx, input.userId, input.chatId, input.now);
      if (!sameIdentity(active.identity, input)) return { kind: 'stale' };
      if (currentPending?.kind === 'edit') return { kind: 'updating' };
      return { kind: 'accepted', active: active.identity, view: active.view };
    });
  }

  async close(input: HomeIdentity & { now: Date }): Promise<'closed' | 'stale'> {
    return this.db.transaction((tx) => {
      const row = this.find(tx, input.userId, input.chatId);
      const active = row && activeOf(row);
      if (!active || !sameIdentity(active.identity, input)) return 'stale';
      tx.delete(homeSessions).where(this.key(input.userId, input.chatId)).run();
      return 'closed';
    });
  }

  private find(db: SessionWriter, userId: number, chatId: number): SessionRow | undefined {
    return db.select().from(homeSessions).where(this.key(userId, chatId)).get();
  }

  private key(userId: number, chatId: number) {
    return and(eq(homeSessions.userId, userId), eq(homeSessions.chatId, chatId));
  }

  private clearPending(db: SessionWriter, userId: number, chatId: number, now: Date): void {
    db.update(homeSessions)
      .set({ ...clearPendingValues(), updatedAt: now })
      .where(this.key(userId, chatId))
      .run();
  }
}
