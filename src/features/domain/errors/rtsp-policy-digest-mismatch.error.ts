/**
 * The digest a caller committed to is not the one this process last validated.
 *
 * The fence is synchronous on purpose: a caller that re-checked the policy and
 * then awaited anything could commit against a policy that has since been
 * replaced by a reinstall.
 */
export class RtspPolicyDigestMismatchError extends Error {
  readonly code = 'RTSP_POLICY_DIGEST_MISMATCH' as const;

  constructor(readonly expected: string) {
    super('Installed RTSP network policy digest changed');
    this.name = 'RtspPolicyDigestMismatchError';
  }
}
