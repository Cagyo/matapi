export const HOME_PENDING_TTL_MS = 60_000;

export type HomeView =
  | { kind: 'home'; checking: boolean }
  | { kind: 'sensors'; page: number; checking: boolean };

export interface HomeIdentity {
  userId: number;
  chatId: number;
  messageId: number;
  token: string;
  revision: number;
}

export interface HomeReservation {
  kind: 'new' | 'edit';
  userId: number;
  chatId: number;
  messageId: number | null;
  token: string;
  revision: number;
  view: HomeView;
  expiresAt: Date;
}

export type ReserveEditResult =
  | { kind: 'reserved'; reservation: HomeReservation }
  | { kind: 'stale' | 'closed' };

export type PromoteResult =
  | { kind: 'promoted'; active: HomeIdentity; previous: HomeIdentity | null }
  | { kind: 'lost' };

export type ValidateHomeResult =
  | { kind: 'accepted'; active: HomeIdentity; view: HomeView }
  | { kind: 'updating' | 'stale' | 'closed' };
