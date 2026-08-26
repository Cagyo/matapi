import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  LiveSourcePolicyEvaluatorPort,
  RtspSourcePolicyNetwork,
  RtspSourcePolicyRelationship,
} from '../domain/ports/live-source-policy-evaluator.port';

/**
 * Upper bound on the answers one host may fan out to before the relationship
 * stops being decidable. A host inside the cap is judged address by address; a
 * host beyond it is `blocked` rather than truncated, because truncating would
 * let a hostile resolver hide an out-of-policy address behind the first few
 * in-policy ones and earn an `allowed` it did not deserve.
 */
const MAX_RESOLVED_ADDRESSES = 8;

/** Every address in `::ffff:0:0/96` is an IPv4 address wearing an IPv6 shape. */
const MAPPED_IPV4_PREFIX = 0xffffn;

export interface SystemLiveSourcePolicyEvaluatorDependencies {
  lookup(hostname: string): Promise<readonly { address: string; family: number }[]>;
}

interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

interface NormalizedAddress {
  family: 4 | 6;
  value: bigint;
}

/**
 * Resolves the credential-free host of a stored source and places it against
 * the installed policy networks.
 *
 * This is a read-only status projection: it opens no stream, spawns no child,
 * and is handed a host rather than a URL, so no credential exists on this path
 * to leak. It resolves on every call — the answer describes the network as it
 * is now, not as it was when the source was verified.
 *
 * The containment arithmetic deliberately mirrors the probe adapter's, which
 * owns the enforcement copy: same prefix floor, same rejection of a CIDR with
 * host bits set, same fail-closed behaviour on a family mismatch. It is a
 * separate implementation because this one must additionally fold IPv4-mapped
 * IPv6 answers down to IPv4, takes the structured installed-network projection
 * instead of the environment's comma-separated string, and must degrade to a
 * status rather than throw a probe error. See the report note attached to the
 * task: extracting one shared value object is the follow-up.
 */
export class SystemLiveSourcePolicyEvaluatorAdapter
  implements LiveSourcePolicyEvaluatorPort
{
  readonly #lookup: SystemLiveSourcePolicyEvaluatorDependencies['lookup'];

  constructor(dependencies: Partial<SystemLiveSourcePolicyEvaluatorDependencies> = {}) {
    this.#lookup = dependencies.lookup ?? defaultLookup;
  }

  async evaluate(
    credentialFreeHost: string,
    policy: { networks: readonly RtspSourcePolicyNetwork[] },
  ): Promise<RtspSourcePolicyRelationship> {
    const hostname = parseHostname(credentialFreeHost);
    if (hostname === null) return 'unresolved';

    // No policy network can contain anything, so nothing is resolved for it.
    const cidrs = parseNetworks(policy.networks);
    if (cidrs.length === 0) return 'blocked';

    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [hostname]
      : await this.resolveAddresses(hostname);
    if (addresses === null) return 'unresolved';
    if (addresses.length === 0) return 'unresolved';
    if (addresses.length > MAX_RESOLVED_ADDRESSES) return 'blocked';

    for (const address of addresses) {
      const normalized = normalizeAddress(address);
      // An answer that cannot be canonicalized — a scoped or malformed address
      // — is inside no network, so it fails closed like any outside address.
      if (normalized === null) return 'blocked';
      if (!cidrs.some((cidr) => contains(cidr, normalized))) return 'blocked';
    }
    return 'allowed';
  }

  /**
   * `null` marks a resolver failure. The rejection carries the hostname, so it
   * is discarded here rather than re-thrown or logged.
   */
  private async resolveAddresses(hostname: string): Promise<string[] | null> {
    try {
      const answers = await this.#lookup(hostname);
      return answers.map((answer) => answer.address);
    } catch {
      return null;
    }
  }
}

async function defaultLookup(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * `LiveSourceSummary.host` is a URL authority: it may carry a port and wraps an
 * IPv6 literal in brackets. Only the bare hostname is ever resolved.
 */
function parseHostname(credentialFreeHost: string): string | null {
  if (typeof credentialFreeHost !== 'string' || !credentialFreeHost) return null;
  try {
    const hostname = new URL(`rtsp://${credentialFreeHost}/`).hostname.replace(
      /^\[|\]$/gu,
      '',
    );
    return hostname || null;
  } catch {
    return null;
  }
}

/** Unusable entries are dropped rather than rejected: valid siblings still grant. */
function parseNetworks(networks: readonly RtspSourcePolicyNetwork[]): ParsedCidr[] {
  const parsed: ParsedCidr[] = [];
  for (const network of networks) {
    const cidr = parseCidr(network);
    if (cidr !== null) parsed.push(cidr);
  }
  return parsed;
}

function parseCidr(network: RtspSourcePolicyNetwork): ParsedCidr | null {
  if (typeof network?.cidr !== 'string') return null;
  const match = /^([^/]+)\/(\d{1,3})$/u.exec(network.cidr.trim());
  if (!match) return null;
  const address = normalizeAddress(match[1]);
  if (address === null) return null;
  // The declared family and the written address must agree, or the entry
  // describes two different networks and is trusted for neither.
  if (address.family !== network.family) return null;
  const prefix = Number(match[2]);
  const bits = address.family === 4 ? 32 : 128;
  if (prefix < 8 || prefix > bits) return null;
  const hostBits = BigInt(bits - prefix);
  const masked = (address.value >> hostBits) << hostBits;
  // A CIDR with host bits set is a misconfiguration, not a narrower network.
  if (masked !== address.value) return null;
  return { family: address.family, network: masked, prefix };
}

function contains(cidr: ParsedCidr, address: NormalizedAddress): boolean {
  if (cidr.family !== address.family) return false;
  const hostBits = BigInt((cidr.family === 4 ? 32 : 128) - cidr.prefix);
  return (address.value >> hostBits) << hostBits === cidr.network;
}

/**
 * Canonicalizes one address into the family it actually belongs to. An
 * IPv4-mapped IPv6 answer such as `::ffff:192.168.1.5` is folded to IPv4 —
 * left as IPv6 it would be compared only against IPv6 networks and silently
 * mis-classified.
 */
function normalizeAddress(raw: string): NormalizedAddress | null {
  const family = isIP(raw);
  if (family === 4) return { family: 4, value: ipv4Value(raw) };
  if (family !== 6) return null;
  const canonical = canonicalIpv6(raw);
  if (canonical === null) return null;
  const value = ipv6Value(canonical);
  if (value === null) return null;
  return value >> 32n === MAPPED_IPV4_PREFIX
    ? { family: 4, value: value & 0xffffffffn }
    : { family: 6, value };
}

/**
 * Expands `::` and folds any embedded dotted quad into hexadecimal groups, so
 * the group parser below only ever sees eight of them. A zone-scoped address
 * has no canonical form here and is rejected.
 */
function canonicalIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function ipv4Value(address: string): bigint {
  return address
    .split('.')
    .reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(address: string): bigint | null {
  const [leftRaw, rightRaw = ''] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => '0');
  const groups = [...left, ...zeros, ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/iu.test(group || '0')) return null;
    value = (value << 16n) | BigInt(`0x${group || '0'}`);
  }
  return value;
}
