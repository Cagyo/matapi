export const HEARTBEAT_CLIENT = Symbol('HEARTBEAT_CLIENT');

/**
 * Outbound port for the external dead-system heartbeat (spec 22). The worker
 * pings an external monitor (e.g. UptimeRobot) on an interval; if the pings
 * stop the monitor alerts out-of-band. All HTTP concerns (URL resolution,
 * timeout, no-op when unconfigured) live in the adapter, never the caller.
 */
export interface HeartbeatClientPort {
  /**
   * Ping the external monitor once. A no-op when `HEARTBEAT_URL` is unset.
   * Throws on network/timeout failure so the scheduler can log it.
   */
  pingExternal(): Promise<void>;
}
