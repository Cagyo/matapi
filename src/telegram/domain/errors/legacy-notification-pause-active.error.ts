/**
 * Raised when a timed non-critical pause is requested for a user who is still
 * under the legacy indefinite mute (`users.muted = true`). The legacy pause
 * must be resumed before a bounded 1/4/8-hour pause can be created. Carries no
 * Telegram ID in its message.
 */
export class LegacyNotificationPauseActiveError extends Error {
  readonly code = 'LEGACY_NOTIFICATION_PAUSE_ACTIVE' as const;
  constructor() {
    super(
      'A legacy indefinite pause is active; resume notifications before ' +
        'starting a timed pause.',
    );
    this.name = 'LegacyNotificationPauseActiveError';
  }
}
