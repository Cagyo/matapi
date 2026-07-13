import type {
  HomeIdentity,
  HomeReservation,
  HomeView,
  PromoteResult,
  ReserveEditResult,
  ValidateHomeResult,
} from '../domain/home-session';
import type { HomeSessionStorePort } from '../domain/ports/home-session-store.port';

interface SessionRow {
  active: HomeIdentity | null;
  activeView: HomeView | null;
  pending: HomeReservation | null;
}

function keyOf(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function cloneView(view: HomeView): HomeView {
  return view.kind === 'home' ? { ...view } : { ...view };
}

function cloneIdentity(identity: HomeIdentity): HomeIdentity {
  return { ...identity };
}

function cloneReservation(reservation: HomeReservation): HomeReservation {
  return {
    ...reservation,
    view: cloneView(reservation.view),
    expiresAt: new Date(reservation.expiresAt),
  };
}

function sameIdentity(left: HomeIdentity, right: HomeIdentity): boolean {
  return (
    left.userId === right.userId &&
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.token === right.token &&
    left.revision === right.revision
  );
}

function sameView(left: HomeView, right: HomeView): boolean {
  return (
    left.kind === right.kind &&
    left.checking === right.checking &&
    (left.kind !== 'sensors' || right.kind !== 'sensors' || left.page === right.page)
  );
}

function sameReservation(left: HomeReservation, right: HomeReservation): boolean {
  return (
    left.kind === right.kind &&
    left.userId === right.userId &&
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.token === right.token &&
    left.revision === right.revision &&
    sameView(left.view, right.view) &&
    left.expiresAt.getTime() === right.expiresAt.getTime()
  );
}

function isExpired(reservation: HomeReservation, now: Date): boolean {
  return now.getTime() >= reservation.expiresAt.getTime();
}

function asIdentity(reservation: HomeReservation): HomeIdentity {
  if (reservation.messageId === null) {
    throw new RangeError('A pending new Home reservation has no message identity');
  }
  return {
    userId: reservation.userId,
    chatId: reservation.chatId,
    messageId: reservation.messageId,
    token: reservation.token,
    revision: reservation.revision,
  };
}

/** Bounded development/test adapter; production persistence mirrors these CAS rules. */
export class InMemoryHomeSessionStore implements HomeSessionStorePort {
  private readonly sessions = new Map<string, SessionRow>();

  async reserveNew(input: {
    userId: number;
    chatId: number;
    token: string;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<HomeReservation> {
    const key = keyOf(input.userId, input.chatId);
    const row = this.sessions.get(key) ?? { active: null, activeView: null, pending: null };
    const reservation: HomeReservation = {
      kind: 'new',
      userId: input.userId,
      chatId: input.chatId,
      messageId: null,
      token: input.token,
      revision: 1,
      view: cloneView(input.view),
      expiresAt: new Date(input.expiresAt),
    };

    row.pending = reservation;
    this.sessions.set(key, row);
    return cloneReservation(reservation);
  }

  async reserveEdit(input: {
    active: HomeIdentity;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<ReserveEditResult> {
    const key = keyOf(input.active.userId, input.active.chatId);
    const row = this.sessions.get(key);
    if (!row) return { kind: 'closed' };
    this.discardExpiredPending(row, input.now);
    this.deleteIfEmpty(key, row);
    if (!row.active) return { kind: 'closed' };
    if (!sameIdentity(row.active, input.active)) return { kind: 'stale' };
    const highestRevision = Math.max(row.active.revision, row.pending?.revision ?? 0);
    if (highestRevision >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Home session revision cannot exceed Number.MAX_SAFE_INTEGER');
    }

    const reservation: HomeReservation = {
      kind: 'edit',
      userId: row.active.userId,
      chatId: row.active.chatId,
      messageId: row.active.messageId,
      token: row.active.token,
      revision: highestRevision + 1,
      view: cloneView(input.view),
      expiresAt: new Date(input.expiresAt),
    };
    row.pending = reservation;
    return { kind: 'reserved', reservation: cloneReservation(reservation) };
  }

  async promoteNew(
    reservation: HomeReservation,
    messageId: number,
    now: Date,
  ): Promise<PromoteResult> {
    if (reservation.kind !== 'new') return { kind: 'lost' };
    const key = keyOf(reservation.userId, reservation.chatId);
    const row = this.sessions.get(key);
    if (!row) return { kind: 'lost' };
    this.discardExpiredPending(row, now);
    if (!row.pending || !sameReservation(row.pending, reservation)) {
      this.deleteIfEmpty(key, row);
      return { kind: 'lost' };
    }

    const previous = row.active ? cloneIdentity(row.active) : null;
    const active: HomeIdentity = {
      userId: reservation.userId,
      chatId: reservation.chatId,
      messageId,
      token: reservation.token,
      revision: reservation.revision,
    };
    row.active = active;
    row.activeView = cloneView(reservation.view);
    row.pending = null;
    return { kind: 'promoted', active: cloneIdentity(active), previous };
  }

  async promoteEdit(reservation: HomeReservation, now: Date): Promise<PromoteResult> {
    if (reservation.kind !== 'edit' || reservation.messageId === null) return { kind: 'lost' };
    const row = this.sessions.get(keyOf(reservation.userId, reservation.chatId));
    if (!row) return { kind: 'lost' };
    this.discardExpiredPending(row, now);
    if (!row.pending || !sameReservation(row.pending, reservation)) return { kind: 'lost' };

    const previous = row.active ? cloneIdentity(row.active) : null;
    const active = asIdentity(reservation);
    row.active = active;
    row.activeView = cloneView(reservation.view);
    row.pending = null;
    return { kind: 'promoted', active: cloneIdentity(active), previous };
  }

  async abandon(reservation: HomeReservation): Promise<void> {
    const key = keyOf(reservation.userId, reservation.chatId);
    const row = this.sessions.get(key);
    if (row?.pending && sameReservation(row.pending, reservation)) {
      row.pending = null;
      this.deleteIfEmpty(key, row);
    }
  }

  async validate(input: HomeIdentity & { now: Date }): Promise<ValidateHomeResult> {
    const key = keyOf(input.userId, input.chatId);
    const row = this.sessions.get(key);
    if (!row) return { kind: 'closed' };
    this.discardExpiredPending(row, input.now);
    this.deleteIfEmpty(key, row);
    if (!row.active || !row.activeView) return { kind: 'closed' };

    const pending = row.pending;
    if (pending?.kind === 'edit' && sameIdentity(asIdentity(pending), input)) {
      row.active = asIdentity(pending);
      row.activeView = cloneView(pending.view);
      row.pending = null;
      return {
        kind: 'accepted',
        active: cloneIdentity(row.active),
        view: cloneView(row.activeView),
      };
    }

    if (sameIdentity(row.active, input)) {
      if (pending?.kind === 'edit') return { kind: 'updating' };
      return {
        kind: 'accepted',
        active: cloneIdentity(row.active),
        view: cloneView(row.activeView),
      };
    }

    return { kind: 'stale' };
  }

  async close(input: HomeIdentity & { now: Date }): Promise<'closed' | 'stale'> {
    const key = keyOf(input.userId, input.chatId);
    const row = this.sessions.get(key);
    if (!row?.active || !sameIdentity(row.active, input)) return 'stale';

    this.sessions.delete(key);
    return 'closed';
  }

  private discardExpiredPending(row: SessionRow, now: Date): void {
    if (row.pending && isExpired(row.pending, now)) {
      row.pending = null;
    }
  }

  private deleteIfEmpty(key: string, row: SessionRow): void {
    if (!row.active && !row.pending) {
      this.sessions.delete(key);
    }
  }
}
