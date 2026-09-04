import type { LiveViewPolicyRequestV1 } from "../live-view-policy";

export const LIVE_VIEW_POLICY_REQUEST = Symbol("LIVE_VIEW_POLICY_REQUEST");

export interface LiveViewPolicyRequestPort {
  publish(
    request: LiveViewPolicyRequestV1,
  ): Promise<"published" | "already-published">;
}
