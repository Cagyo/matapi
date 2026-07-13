export const STREAM_EGRESS = Symbol('STREAM_EGRESS');

export type ValidatedLiteralAddress =
  | { family: 'ipv4'; address: string }
  | { family: 'ipv6'; address: string };

export interface UdpMediaPortRange {
  first: number;
  last: number;
}

export type StreamEgressTransport =
  | { transport: 'tcp' }
  | { transport: 'udp'; udpMediaPorts: UdpMediaPortRange }
  | { transport: 'auto'; udpMediaPorts: UdpMediaPortRange };

export interface StreamEgressLease {
  sessionId: string;
  leaseId: string;
}

export interface StreamEgressPort {
  grant(
    input: {
      sessionId: string;
      nonce: string;
      addresses: readonly ValidatedLiteralAddress[];
      rtspControlPorts: readonly number[];
      expiresAtUnixMs: number;
    } & StreamEgressTransport,
  ): Promise<StreamEgressLease>;
  revoke(lease: StreamEgressLease): Promise<void>;
}
