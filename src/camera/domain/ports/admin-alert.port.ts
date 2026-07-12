export const ADMIN_ALERT = Symbol('ADMIN_ALERT');

/** Distinct admin-facing camera alerts (specs 20, 21). */
export type CameraAdminAlert =
  | 'motion-daemon-down'
  | 'motion-daemon-recovered'
  | 'gdrive-sync-failing'
  | 'disk-warning'
  | 'emergency-disk-cleanup'
  | 'live-stream-recovery-failed';

/**
 * Sends an alert to administrators only (spec 19 → admins-only events,
 * spec 20 → daemon failures, spec 21 → sync/disk failures). Owned by the
 * camera context; the message wording lives in the telegram adapter so the
 * camera stays locale-free. `detail` carries an optional error string for
 * alerts that surface a cause (e.g. `gdrive-sync-failing`).
 */
export interface AdminAlertPort {
  alert(kind: CameraAdminAlert, detail?: string): Promise<void>;
}
