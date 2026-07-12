export class SensorLogExportRowTooLargeError extends Error {
  readonly code = 'SENSOR_LOG_EXPORT_ROW_TOO_LARGE' as const;

  constructor(
    readonly messageBytes: number,
    readonly maxMessageBytes: number,
  ) {
    super(
      `Selected sensor log message is ${messageBytes} bytes; export limit is ${maxMessageBytes} bytes`,
    );
    this.name = 'SensorLogExportRowTooLargeError';
  }
}
