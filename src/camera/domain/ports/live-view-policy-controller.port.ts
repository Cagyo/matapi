export const LIVE_VIEW_POLICY_CONTROLLER = Symbol(
  "LIVE_VIEW_POLICY_CONTROLLER",
);

export interface LiveViewPolicyControllerPort {
  start(): Promise<void>;
}
