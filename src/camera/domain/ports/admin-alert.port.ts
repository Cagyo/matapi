export const ADMIN_ALERT = Symbol('ADMIN_ALERT');

/** Distinct admin-facing camera alerts (spec 20 — daemon lifecycle). */
export type CameraAdminAlert = 'motion-daemon-down' | 'motion-daemon-recovered';

/**
 * Sends an alert to administrators only (spec 19 → admins-only events,
 * spec 20 → daemon failures). Owned by the camera context; the message
 * wording lives in the telegram adapter so the camera stays locale-free.
 */
export interface AdminAlertPort {
  alert(kind: CameraAdminAlert): Promise<void>;
}
