/**
 * Raised when a pause/resume mutation loses a compare-and-swap race: the user's
 * notification-pause revision changed between the read and the write. The caller
 * should re-read state and retry. Carries no Telegram ID in its message.
 */
export class NotificationPauseConflictError extends Error {
  readonly code = 'NOTIFICATION_PAUSE_CONFLICT' as const;
  constructor() {
    super('The notification pause state changed concurrently; please retry.');
    this.name = 'NotificationPauseConflictError';
  }
}
