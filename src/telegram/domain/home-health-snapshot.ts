export const HOME_HEALTH_FRESH_MS = 120_000;

/** A health result is usable only when it came from the current clock window. */
export function isHomeHealthFresh(completedAt: Date, now: Date): boolean {
  const age = now.getTime() - completedAt.getTime();
  return age >= 0 && age < HOME_HEALTH_FRESH_MS;
}

export interface HomeHealthSnapshot {
  completedAt: Date;
  enabledSensorIds: readonly string[];
  onlineSensorIds: readonly string[];
  missingSensorIds: readonly string[];
  failedSensorIds: readonly string[];
  timedOutSensorIds: readonly string[];
  offlineSensorIds: readonly string[];
}
