import type { RtspPolicyStatus } from '../ports/rtsp-policy-status.port';

/** The installed RTSP policy is not the currently valid one for this network. */
export class RtspPolicyUnavailableError extends Error {
  readonly code = 'RTSP_POLICY_UNAVAILABLE' as const;

  constructor(readonly state: Exclude<RtspPolicyStatus['state'], 'ready'>) {
    super(`Installed RTSP network policy is ${state}`);
    this.name = 'RtspPolicyUnavailableError';
  }
}
