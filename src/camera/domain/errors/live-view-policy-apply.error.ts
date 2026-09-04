export class LiveViewPolicyApplyError extends Error {
  readonly code = "LIVE_VIEW_POLICY_APPLY_INVALID" as const;

  constructor() {
    super("Live view policy apply state is invalid");
    this.name = "LiveViewPolicyApplyError";
  }
}
