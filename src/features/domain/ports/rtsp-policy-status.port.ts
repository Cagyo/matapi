/**
 * The installed RTSP network policy, as one verified projection.
 *
 * Camera grants, install recovery, and application readiness all need the same
 * answer to "is the policy this process was started with still the installed,
 * currently valid one?". Three independent readers would disagree the moment a
 * reinstall renames one of the three durable artifacts, so every consumer reads
 * this port instead of the policy files or the environment.
 *
 * Only the redacted projection below crosses the boundary: never the private
 * policy, the UID inventory, the environment, or any helper output.
 */
export const RTSP_POLICY_STATUS = Symbol('RTSP_POLICY_STATUS');

export interface InstalledRtspNetwork {
  family: 4 | 6;
  cidr: string;
  interface: string;
}

export type RtspPolicyStatus =
  | { state: 'ready'; digest: string; networks: readonly InstalledRtspNetwork[] }
  | { state: 'stale'; digest: string | null; networks: readonly InstalledRtspNetwork[] }
  | { state: 'unavailable'; digest: null; networks: readonly [] };

export interface RtspPolicyStatusPort {
  /** Never throws for an expected failure: an unreadable answer is `unavailable`. */
  inspect(): Promise<RtspPolicyStatus>;

  /** The installed projection, or `RtspPolicyUnavailableError` when it is not current. */
  requireCurrent(): Promise<{
    digest: string;
    networks: readonly InstalledRtspNetwork[];
  }>;

  /** Synchronous final fence over the last validated process-visible digest. */
  assertDigest(expected: string): void;
}
