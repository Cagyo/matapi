export const NOTIFICATION_PAUSE_REPOSITORY = Symbol('NOTIFICATION_PAUSE_REPOSITORY');
export const MAX_NOTIFICATION_PAUSE_RECEIPTS_PER_USER = 32;
export type PauseDurationHours = 1 | 4 | 8;

/** Snapshot of a user's pause-relevant state for compare-and-swap mutations. */
export interface NotificationPauseState {
  userId: number;
  legacyMuted: boolean;
  nonCriticalPausedUntil: Date | null;
  revision: number;
}

export interface QuietHoursNotificationPauseState extends NotificationPauseState {
  quietStart: string | null;
  quietEnd: string | null;
}

export interface CompareAndSetQuietHoursCommand {
  userId: number;
  expectedRevision: number;
  start: string | null;
  end: string | null;
  now: Date;
}

export type CompareAndSetQuietHoursResult =
  | { kind: 'applied'; state: QuietHoursNotificationPauseState; changed: boolean }
  | { kind: 'not_found' | 'conflict' };

export interface ApplyNonCriticalPauseCommand {
  userId: number;
  expectedRevision: number;
  pausedUntil: Date;
  now: Date;
}

export type ApplyNonCriticalPauseResult =
  | { kind: 'applied'; state: NotificationPauseState; receiptId: number }
  | { kind: 'not_found' | 'legacy_active' | 'conflict' };

export interface ResumeNotificationsCommand {
  userId: number;
  expectedRevision: number;
  now: Date;
}

export type ResumeNotificationsResult =
  | { kind: 'applied'; state: NotificationPauseState; changed: boolean }
  | { kind: 'not_found' | 'conflict' };

export type UndoNonCriticalPauseResult =
  | { kind: 'applied'; state: NotificationPauseState }
  | { kind: 'not_found' | 'consumed' | 'expired' | 'superseded' };

/**
 * Atomic per-user pause/resume/undo contract (spec 12, 19). Implemented by the
 * same user repositories (in-memory + Drizzle) so recipient reads and pause
 * mutations cannot diverge. Every mutation that changes `legacyMuted` or
 * `nonCriticalPausedUntil` increments the revision, superseding stale receipts.
 */
export interface NotificationPauseRepositoryPort {
  getNotificationPauseState(userId: number): Promise<NotificationPauseState | null>;
  applyNonCriticalPause(
    command: ApplyNonCriticalPauseCommand,
  ): Promise<ApplyNonCriticalPauseResult>;
  resumeNotifications(
    command: ResumeNotificationsCommand,
  ): Promise<ResumeNotificationsResult>;
  compareAndSetQuietHours(
    command: CompareAndSetQuietHoursCommand,
  ): Promise<CompareAndSetQuietHoursResult>;
  undoNonCriticalPause(
    userId: number,
    receiptId: number,
    now: Date,
  ): Promise<UndoNonCriticalPauseResult>;
}
