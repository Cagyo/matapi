export const LIVE_VIEW_POLICY_ACKNOWLEDGEMENT = Symbol(
  "LIVE_VIEW_POLICY_ACKNOWLEDGEMENT",
);

export interface LiveViewPolicyAcknowledgementPort {
  publish(requestId: string): Promise<"published" | "already-published">;
}
