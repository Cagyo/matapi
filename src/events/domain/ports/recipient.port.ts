export const RECIPIENT_DIRECTORY = Symbol('RECIPIENT_DIRECTORY');

/** A notification recipient with the fields needed to filter delivery. */
export interface NotificationRecipient {
  telegramId: number;
  /** Global mute (`/mute` with no sensor — spec 12). */
  muted: boolean;
  /** Quiet-hours window bounds (`HH:MM`, local TZ) or `null` when disabled. */
  quietStart: string | null;
  quietEnd: string | null;
}

/**
 * Read model the notification pipeline uses to fan out to users (spec 19).
 *
 * Owned by the `events` context but implemented in `telegram`, where the
 * user and per-sensor-mute repositories live. Because `events` cannot
 * DI-import `telegram` (the dependency runs the other way), the concrete
 * adapter is bound at runtime through `RecipientDirectoryService.register()`
 * — the same seam used by `EventNotifierService` for `NotifierPort`.
 */
export interface RecipientDirectoryPort {
  /** All registered users eligible to receive notifications. */
  listRecipients(): Promise<NotificationRecipient[]>;
  /** Whether a user has muted this specific sensor (`/mute <sensor>`). */
  isSensorMuted(telegramId: number, sensorId: string): Promise<boolean>;
}
