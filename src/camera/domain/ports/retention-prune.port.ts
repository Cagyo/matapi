export const RETENTION_PRUNE = Symbol('RETENTION_PRUNE');

/**
 * Emergency retention pruning invoked only during emergency disk cleanup
 * (spec 21 — disk ≥ `DISK_EMERGENCY_PERCENT`). Deletes already-sent events and
 * old sensor logs to reclaim space. Behind a port so the camera context never
 * reaches into the events/sensors tables directly.
 */
export interface RetentionPrunePort {
  /** Delete already-sent events older than `cutoff`. Returns rows removed. */
  pruneEventsOlderThan(cutoff: Date): Promise<number>;
  /** Delete sensor logs older than `cutoff`. Returns rows removed. */
  pruneSensorLogsOlderThan(cutoff: Date): Promise<number>;
}
