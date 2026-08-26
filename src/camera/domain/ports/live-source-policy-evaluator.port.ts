export const LIVE_SOURCE_POLICY_EVALUATOR = Symbol('LIVE_SOURCE_POLICY_EVALUATOR');

/**
 * Where a stored source sits relative to the RTSP network policy *right now*.
 *
 * `allowed` is the strict answer: every address the credential-free host
 * currently resolves to belongs to a policy network. One address outside makes
 * the whole host `blocked`, and a host that cannot be resolved at all is
 * `unresolved` — never silently allowed.
 */
export type RtspSourcePolicyRelationship = 'allowed' | 'blocked' | 'unresolved';

/**
 * One installed policy network, structurally identical to the features
 * context's `InstalledRtspNetwork`. Restated here so the camera domain owns its
 * own port shape rather than importing another context's domain type.
 */
export interface RtspSourcePolicyNetwork {
  family: 4 | 6;
  cidr: string;
  interface: string;
}

/**
 * Answers "does this host resolve inside the installed policy?" without ever
 * touching a credential.
 *
 * The only input is the credential-free host from `LiveSourceSummary` — no URL,
 * no userinfo, no path — so an implementation has nothing secret to leak into a
 * resolver, a log line, or an error. Implementations must resolve on every call
 * rather than caching: a host that rebinds between two evaluations has to be
 * reported as it answers now.
 */
export interface LiveSourcePolicyEvaluatorPort {
  evaluate(
    credentialFreeHost: string,
    policy: { networks: readonly RtspSourcePolicyNetwork[] },
  ): Promise<RtspSourcePolicyRelationship>;
}
