export class InvalidLiveViewCidrError extends Error {
  readonly code = "INVALID_LIVE_VIEW_CIDR" as const;

  constructor() {
    super(
      "Live view camera CIDR is invalid or outside the private-network allowlist",
    );
    this.name = "InvalidLiveViewCidrError";
  }
}
