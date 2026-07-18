import type { ReleaseFeedTimeouts } from "../../domain/ports/release-feed-transport.port";
export const UPDATE_CHECK_OPTIONS = Symbol("UPDATE_CHECK_OPTIONS");

export interface UpdateCheckOptions {
  feedUrl: string;
  maxEnvelopeBytes: number;
  timeouts: ReleaseFeedTimeouts;
}
