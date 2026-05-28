export const SYSTEM_HEALTH = Symbol('SYSTEM_HEALTH');

/** OS-level snapshot consumed by the `/health` bot command (spec 08). */
export interface SystemHealthSnapshot {
  /** Bytes used on the worker's root partition. `null` when `df` fails. */
  diskUsedBytes: number | null;
  /** Total bytes on the worker's root partition. */
  diskTotalBytes: number | null;
  /** CPU package temperature in °C, or `null` on platforms without it. */
  cpuTempC: number | null;
  /** Memory used by the worker process (RSS). */
  memoryUsedBytes: number;
  /** Total host memory. */
  memoryTotalBytes: number;
  /** Worker process uptime in seconds. */
  uptimeSec: number;
  /** Size of the SQLite database file, or `null` when stat fails. */
  dbSizeBytes: number | null;
}

export interface SystemHealthPort {
  collect(): Promise<SystemHealthSnapshot>;
}
