export const CLOCK_SYNC_PROBE = Symbol('CLOCK_SYNC_PROBE');

/** Result of probing the host's NTP synchronisation state (spec 23). */
export interface ClockSyncStatus {
  /** Whether the system clock is synchronised to a time source. */
  synchronized: boolean;
  /**
   * Estimated offset from the time source in milliseconds, or `null` when
   * the platform cannot report it.
   */
  offsetMs: number | null;
}

/**
 * Reports whether the host clock is synchronised (spec 23 — Clock Drift). Used
 * at boot to log a warning when timestamps recorded before NTP sync may drift.
 */
export interface ClockSyncProbePort {
  probe(): Promise<ClockSyncStatus>;
}
