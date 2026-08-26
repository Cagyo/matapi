export const LIVE_SOURCE_POLICY_EVALUATOR = Symbol('LIVE_SOURCE_POLICY_EVALUATOR');

/**
 * Where a stored source sits relative to the RTSP network policy *right now*.
 *
 * `allowed` is the strict answer: every address every one of the source's
 * credential-free hosts currently resolves to belongs to a policy network. One
 * address outside makes the whole source `blocked`, and a host that cannot be
 * resolved at all is `unresolved` — never silently allowed.
 *
 * **Never an authorization input.** This is a status projection for an
 * operator, computed from DNS answers that may change between this call and the
 * next one. Enforcement is the probe's own containment check plus the installed
 * packet policy, and both must run in full regardless of what this reports. A
 * caller that skips a probe because the overview already said `allowed` has
 * turned a display hint into a TOCTOU hole.
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
 * Answers "does this source resolve inside the installed policy?" without ever
 * touching a credential.
 *
 * The only input is the credential-free hosts from `LiveSourceSummary` — no
 * URL, no userinfo, no path — so an implementation has nothing secret to leak
 * into a resolver, a log line, or an error.
 *
 * A source may stream from more than one authority: enforcement validates the
 * primary *and* the substream, and for the `eco` profile the substream is the
 * URL actually selected. So the caller passes every host the source can use and
 * gets back one relationship for the source as a whole, combined worst-first
 * (`blocked` beats `unresolved` beats `allowed`).
 *
 * Implementations must resolve on every call rather than caching: a host that
 * rebinds between two evaluations has to be reported as it answers now.
 */
export interface LiveSourcePolicyEvaluatorPort {
  evaluate(
    credentialFreeHosts: readonly string[],
    policy: { networks: readonly RtspSourcePolicyNetwork[] },
  ): Promise<RtspSourcePolicyRelationship>;
}
