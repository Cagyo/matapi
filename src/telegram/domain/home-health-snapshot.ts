export const HOME_HEALTH_FRESH_MS = 120_000;

export interface HomeHealthSnapshot {
  completedAt: Date;
  enabledSensorIds: readonly string[];
  onlineSensorIds: readonly string[];
  missingSensorIds: readonly string[];
  failedSensorIds: readonly string[];
  timedOutSensorIds: readonly string[];
  offlineSensorIds: readonly string[];
}
