import type {
  HomeIdentity,
  HomeReservation,
  HomeView,
  PromoteResult,
  ReserveEditResult,
  ValidateHomeResult,
} from '../home-session';

export const HOME_SESSION_STORE = Symbol('HOME_SESSION_STORE');

export interface HomeSessionStorePort {
  reserveNew(input: {
    userId: number;
    chatId: number;
    token: string;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<HomeReservation>;
  reserveEdit(input: {
    active: HomeIdentity;
    view: HomeView;
    now: Date;
    expiresAt: Date;
  }): Promise<ReserveEditResult>;
  promoteNew(
    reservation: HomeReservation,
    messageId: number,
    now: Date,
  ): Promise<PromoteResult>;
  promoteEdit(reservation: HomeReservation, now: Date): Promise<PromoteResult>;
  abandon(reservation: HomeReservation): Promise<void>;
  validate(input: HomeIdentity & { now: Date }): Promise<ValidateHomeResult>;
  close(input: HomeIdentity & { now: Date }): Promise<'closed' | 'stale'>;
}
