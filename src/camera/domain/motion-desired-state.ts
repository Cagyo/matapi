/**
 * `system_meta` key recording the admin's intent for the Motion daemon.
 * `'off'` means a deliberate stop (`/camera disable` or the emergency disk
 * cleanup) — the watcher must NOT auto-restart. Absent or `'on'` means the
 * watcher keeps the daemon alive.
 */
export const MOTION_DESIRED_STATE_KEY = 'motion_desired_state';

export type MotionDesiredState = 'on' | 'off';
