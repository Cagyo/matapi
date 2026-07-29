export class DrivePolicyBlockedError extends Error {
  readonly code = "DRIVE_POLICY_BLOCKED" as const;

  constructor(message = "Drive access is blocked by policy") {
    super(message);
    this.name = "DrivePolicyBlockedError";
  }
}
