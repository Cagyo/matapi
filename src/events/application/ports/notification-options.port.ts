export const NOTIFICATION_OPTIONS = Symbol('NOTIFICATION_OPTIONS');

export interface NotificationOptions {
  /** IANA timezone used to evaluate quiet hours (spec 12, 19). */
  timezone: string;
}
