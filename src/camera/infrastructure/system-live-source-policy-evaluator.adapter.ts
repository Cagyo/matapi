import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type {
  LiveSourcePolicyEvaluatorPort,
  RtspSourcePolicyNetwork,
  RtspSourcePolicyRelationship,
} from '../domain/ports/live-source-policy-evaluator.port';

/**
 * Upper bound on the *distinct* addresses one host may fan out to before the
 * relationship stops being decidable, deliberately equal to the ceiling the
 * probe enforces on a grant. A host beyond it is `blocked` rather than
 * truncated: truncating would let a hostile resolver hide an out-of-policy
 * address behind the first few in-policy ones and earn an `allowed` it did not
 * deserve, and reporting `allowed` above the probe's ceiling would promise a
 * stream the probe then refuses.
 */
const MAX_RESOLVED_ADDRESSES = 2;

/**
 * Total budget for one `evaluate` call, shared across every host it resolves.
 *
 * `dns.lookup` is `getaddrinfo` on the libuv threadpool: uncancellable, and
 * bounded only by `/etc/resolv.conf`, which on a stock Pi means up to
 * `timeout x attempts x nameservers` — tens of seconds. Racing a deadline does
 * not hand the threadpool slot back, but it does unblock the caller, and this
 * is a status view rendered behind an operator's keystroke.
 *
 * `dns.Resolver` would offer a real timeout and is still the wrong tool: it
 * talks to nameservers directly, skipping `/etc/hosts` and mDNS, and a camera
 * addressed as `<name>.local` is entirely plausible here.
 */
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

/** Every address in `::ffff:0:0/96` is an IPv4 address wearing an IPv6 shape. */
const MAPPED_IPV4_PREFIX = 0xffffn;

const TIMED_OUT = Symbol('lookup-timed-out');

/** Worst-first, so one bad host decides the source. */
const RELATIONSHIP_SEVERITY: Record<RtspSourcePolicyRelationship, number> = {
  allowed: 0,
  unresolved: 1,
  blocked: 2,
};

export interface SystemLiveSourcePolicyEvaluatorDependencies {
  lookup(hostname: string): Promise<readonly { address: string; family: number }[]>;
  /** Budget for the whole call, not per host. */
  timeoutMs: number;
}

export interface ParsedPolicyCidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

interface NormalizedAddress {
  family: 4 | 6;
  value: bigint;
}

/**
 * Resolves the credential-free hosts of a stored source and places them against
 * the installed policy networks.
 *
 * This is a read-only status projection: it opens no stream, spawns no child,
 * and is handed hosts rather than URLs, so no credential exists on this path to
 * leak. It resolves on every call — the answer describes the network as it is
 * now, not as it was when the source was verified.
 *
 * The containment arithmetic deliberately mirrors the probe adapter's, which
 * owns the enforcement copy: same prefix floor, same rejection of a CIDR with
 * host bits set, same fail-closed behaviour on a family mismatch, same ceiling
 * on distinct addresses. It is a separate implementation because this one must
 * additionally fold IPv4-mapped IPv6 answers down to IPv4, takes the structured
 * installed-network projection instead of the environment's comma-separated
 * string, and must degrade to a status rather than throw a probe error. The
 * remaining divergences are pinned row by row in
 * `test/camera/infrastructure/rtsp-policy-containment.contract.test.ts`, which
 * fails the moment a new one appears. Unifying all three CIDR implementations
 * in this tree — this one, the probe's, and the features context's installed
 * policy adapter — is the deferred follow-up.
 */
export class SystemLiveSourcePolicyEvaluatorAdapter
  implements LiveSourcePolicyEvaluatorPort
{
  readonly #lookup: SystemLiveSourcePolicyEvaluatorDependencies['lookup'];
  readonly #timeoutMs: number;

  constructor(dependencies: Partial<SystemLiveSourcePolicyEvaluatorDependencies> = {}) {
    this.#lookup = dependencies.lookup ?? defaultLookup;
    this.#timeoutMs =
      typeof dependencies.timeoutMs === 'number' &&
      Number.isSafeInteger(dependencies.timeoutMs) &&
      dependencies.timeoutMs > 0
        ? dependencies.timeoutMs
        : DEFAULT_LOOKUP_TIMEOUT_MS;
  }

  async evaluate(
    credentialFreeHosts: readonly string[],
    policy: { networks: readonly RtspSourcePolicyNetwork[] },
  ): Promise<RtspSourcePolicyRelationship> {
    // No policy network can contain anything, so nothing is resolved for it.
    const cidrs = parsePolicyNetworks(policy.networks);
    if (cidrs.length === 0) return 'blocked';

    // A source with no host at all is never shown as allowed.
    const hosts = [...new Set(credentialFreeHosts)];
    if (hosts.length === 0) return 'blocked';

    const answers = await raceDeadline(
      Promise.all(hosts.map((host) => this.resolveHost(host))),
      this.#timeoutMs,
    );
    if (answers === TIMED_OUT) return 'unresolved';

    return answers
      .map((addresses) => classify(addresses, cidrs))
      .reduce(worst, 'allowed');
  }

  /**
   * The addresses one host currently stands for, or `null` when it cannot be
   * resolved. A literal never reaches the resolver. The rejected lookup carries
   * the hostname, so it is discarded here rather than re-thrown or logged.
   */
  private async resolveHost(host: string): Promise<readonly string[] | null> {
    const hostname = parseHostname(host);
    if (hostname === null) return null;
    if (isIP(hostname) !== 0) return [hostname];
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

function classify(
  addresses: readonly string[] | null,
  cidrs: readonly ParsedPolicyCidr[],
): RtspSourcePolicyRelationship {
  if (addresses === null || addresses.length === 0) return 'unresolved';

  // Deduplicated before the ceiling is applied, so a resolver that repeats an
  // answer cannot push a single-homed host over it.
  const distinct = new Map<string, NormalizedAddress>();
  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    // An answer that cannot be canonicalized — scoped, malformed, or not a
    // string at all — is inside no network, so it fails closed.
    if (normalized === null) return 'blocked';
    distinct.set(`${normalized.family}:${normalized.value}`, normalized);
  }
  if (distinct.size > MAX_RESOLVED_ADDRESSES) return 'blocked';
  for (const address of distinct.values()) {
    if (!cidrs.some((cidr) => contains(cidr, address))) return 'blocked';
  }
  return 'allowed';
}

function worst(
  left: RtspSourcePolicyRelationship,
  right: RtspSourcePolicyRelationship,
): RtspSourcePolicyRelationship {
  return RELATIONSHIP_SEVERITY[right] > RELATIONSHIP_SEVERITY[left] ? right : left;
}

function raceDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  // `operation` is built from `resolveHost`, which never rejects, so racing it
  // cannot strand a rejection once the deadline has won.
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

/**
 * `LiveSourceSummary.host` is a URL authority: it may carry a port and wraps an
 * IPv6 literal in brackets. Only the bare hostname is ever resolved.
 *
 * `rtsp:` is a non-special scheme, so WHATWG parses the authority as an opaque
 * host and percent-encodes non-ASCII instead of applying IDNA. That is safe
 * only because every stored host has already been through
 * `canonicalizeHostname` (`live-source.entity.ts`), which runs `domainToASCII`
 * before persistence — this parser must never become the first one to see a
 * raw operator-supplied host.
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
function parsePolicyNetworks(
  networks: readonly RtspSourcePolicyNetwork[],
): ParsedPolicyCidr[] {
  const parsed: ParsedPolicyCidr[] = [];
  for (const network of networks ?? []) {
    const cidr = parsePolicyCidr(network);
    if (cidr !== null) parsed.push(cidr);
  }
  return parsed;
}

function parsePolicyCidr(network: RtspSourcePolicyNetwork): ParsedPolicyCidr | null {
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

function contains(cidr: ParsedPolicyCidr, address: NormalizedAddress): boolean {
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
  if (typeof raw !== 'string') return null;
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
