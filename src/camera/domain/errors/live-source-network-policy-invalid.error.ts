export class LiveSourceNetworkPolicyInvalidError extends Error {
  readonly code = 'LIVE_SOURCE_NETWORK_POLICY_INVALID' as const;

  constructor() {
    super('Live source network policy is invalid');
    this.name = 'LiveSourceNetworkPolicyInvalidError';
  }
}
