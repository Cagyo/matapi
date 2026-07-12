export class SensorLogHistoryEmptyError extends Error {
  readonly code = 'SENSOR_LOG_HISTORY_EMPTY' as const;

  constructor(readonly sensorId: string) {
    super(`Selected sensor log for '${sensorId}' has no rows to export`);
    this.name = 'SensorLogHistoryEmptyError';
  }
}
