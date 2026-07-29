export class DriveClockUnhealthyError extends Error {
  readonly code = "DRIVE_CLOCK_UNHEALTHY" as const;

  constructor(message = "System clock is unhealthy for Drive mutations") {
    super(message);
    this.name = "DriveClockUnhealthyError";
  }
}
