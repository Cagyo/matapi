import type { LiveViewPolicyResultV1 } from "../live-view-policy";

export const LIVE_VIEW_POLICY_RESULT = Symbol("LIVE_VIEW_POLICY_RESULT");

export interface LiveViewPolicyResultPort {
  read(requestId: string): Promise<LiveViewPolicyResultV1 | null>;
}
