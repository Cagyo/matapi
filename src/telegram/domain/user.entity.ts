import { Locale } from './locale';
import { Role } from './role';

export interface User {
  telegramId: number;
  name: string;
  role: Role;
  locale: Locale;
  muted: boolean;
  /** Timed non-critical pause deadline (1/4/8h) or `null` when no timed pause. */
  nonCriticalPausedUntil: Date | null;
  /** Compare-and-swap revision for pause/resume/undo mutations. */
  notificationPauseRevision: number;
  /** Quiet-hours start (`HH:MM`, 24h, local TZ) or `null` when disabled. */
  quietStart: string | null;
  /** Quiet-hours end (`HH:MM`, 24h, local TZ) or `null` when disabled. */
  quietEnd: string | null;
  createdAt: Date | null;
}

export interface NewUser {
  telegramId: number;
  name: string;
  role: Role;
  locale: Locale;
  createdAt: Date;
}
