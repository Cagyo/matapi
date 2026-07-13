import type { StreamEgressGrant } from '../stream-egress-grant.value-object';

export const STREAM_EGRESS = Symbol('STREAM_EGRESS');

export interface StreamEgressLease {
  sessionId: string;
  leaseId: string;
}

export interface StreamEgressPort {
  grant(request: StreamEgressGrant): Promise<StreamEgressLease>;
  revoke(lease: StreamEgressLease): Promise<void>;
}
