import { isIP } from 'node:net';
import { InvalidLiveSourceError } from './errors/invalid-live-source.error';

const MAX_LEASE_MS = 300_000;
const MAX_UDP_PORTS = 64;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NONCE_HASH = /^[0-9a-f]{64}$/iu;

export type ValidatedLiteralAddress =
  | { readonly family: 'ipv4'; readonly address: string }
  | { readonly family: 'ipv6'; readonly address: string };

export interface UdpMediaPortRange {
  first: number;
  last: number;
}

export type StreamEgressGrantInput = {
  sessionId: string;
  nonceHash: string;
  addresses: readonly string[];
  rtspControlPorts: readonly number[];
  expiresAtUnixMs: number;
} & (
  | { transport: 'tcp' }
  | {
      transport: 'udp' | 'auto';
      udpMediaPorts: UdpMediaPortRange;
    }
);

export type ValidatedStreamEgressTransport =
  | { kind: 'tcp' }
  | { kind: 'udp' | 'auto'; udpMediaPorts: Readonly<UdpMediaPortRange> };

export class StreamEgressGrant {
  readonly #validated = true;
  readonly sessionId: string;
  readonly nonceHash: string;
  readonly addresses: readonly ValidatedLiteralAddress[];
  readonly rtspControlPorts: readonly number[];
  readonly transport: ValidatedStreamEgressTransport;
  readonly expiresAtUnixMs: number;

  private constructor(input: {
    sessionId: string;
    nonceHash: string;
    addresses: readonly ValidatedLiteralAddress[];
    rtspControlPorts: readonly number[];
    transport: ValidatedStreamEgressTransport;
    expiresAtUnixMs: number;
  }) {
    this.sessionId = input.sessionId;
    this.nonceHash = input.nonceHash;
    this.addresses = Object.freeze(
      input.addresses.map((address) => Object.freeze({ ...address })),
    );
    this.rtspControlPorts = Object.freeze([...input.rtspControlPorts]);
    this.transport = Object.freeze(input.transport);
    this.expiresAtUnixMs = input.expiresAtUnixMs;
    Object.freeze(this);
  }

  isValidated(): true {
    return this.#validated;
  }

  static create(
    input: StreamEgressGrantInput,
    nowUnixMs: number,
  ): StreamEgressGrant {
    if (typeof input !== 'object' || input === null) invalid('request');
    if (
      typeof nowUnixMs !== 'number' ||
      !Number.isSafeInteger(nowUnixMs) ||
      nowUnixMs < 0
    ) {
      invalid('current time');
    }
    if (typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) {
      invalid('session identifier');
    }
    if (typeof input.nonceHash !== 'string' || !NONCE_HASH.test(input.nonceHash)) {
      invalid('nonce hash');
    }
    if (!Array.isArray(input.addresses)) invalid('addresses');
    if (input.addresses.length < 1 || input.addresses.length > 2) {
      invalid('address count');
    }
    const addresses = input.addresses.map(validateAddress);
    if (new Set(addresses.map(({ address }) => address)).size !== addresses.length) {
      invalid('duplicate address');
    }
    if (!Array.isArray(input.rtspControlPorts)) invalid('control ports');
    if (
      input.rtspControlPorts.length < 1 ||
      input.rtspControlPorts.length > 2 ||
      input.rtspControlPorts.some((port) => !isPort(port)) ||
      new Set(input.rtspControlPorts).size !== input.rtspControlPorts.length
    ) {
      invalid('control ports');
    }
    if (
      typeof input.expiresAtUnixMs !== 'number' ||
      !Number.isSafeInteger(input.expiresAtUnixMs) ||
      input.expiresAtUnixMs < 0 ||
      input.expiresAtUnixMs <= nowUnixMs ||
      input.expiresAtUnixMs - nowUnixMs > MAX_LEASE_MS
    ) {
      invalid('lease expiry');
    }

    let transport: ValidatedStreamEgressTransport;
    if (input.transport === 'tcp') {
      transport = { kind: 'tcp' };
    } else if (input.transport === 'udp' || input.transport === 'auto') {
      const range = input.udpMediaPorts;
      if (
        typeof range !== 'object' ||
        range === null ||
        !isPort(range.first) ||
        !isPort(range.last) ||
        range.first > range.last ||
        range.last - range.first + 1 > MAX_UDP_PORTS
      ) {
        invalid('UDP media port range');
      }
      transport = {
        kind: input.transport,
        udpMediaPorts: Object.freeze({ ...range }),
      };
    } else {
      invalid('transport');
    }

    return new StreamEgressGrant({
      sessionId: input.sessionId.toLowerCase(),
      nonceHash: input.nonceHash.toLowerCase(),
      addresses,
      rtspControlPorts: input.rtspControlPorts,
      transport,
      expiresAtUnixMs: input.expiresAtUnixMs,
    });
  }
}

function validateAddress(address: unknown): ValidatedLiteralAddress {
  if (typeof address !== 'string') invalid('literal address');
  const family = isIP(address);
  if (family !== 4 && family !== 6) invalid('literal address');
  if (family === 4) return { family: 'ipv4', address };
  const canonicalAddress = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return { family: 'ipv6', address: canonicalAddress };
}

function isPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65_535
  );
}

function invalid(field: string): never {
  throw new InvalidLiveSourceError(`stream egress ${field} is malformed`);
}
