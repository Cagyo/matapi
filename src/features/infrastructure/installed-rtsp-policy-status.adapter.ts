import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import { RtspPolicyDigestMismatchError } from '../domain/errors/rtsp-policy-digest-mismatch.error';
import { RtspPolicyUnavailableError } from '../domain/errors/rtsp-policy-unavailable.error';
import type {
  InstalledRtspNetwork,
  RtspPolicyStatus,
  RtspPolicyStatusPort,
} from '../domain/ports/rtsp-policy-status.port';
import {
  RtspPolicyInspectorGateway,
  type RtspPolicyInspector,
} from './readiness/rtsp-policy-inspector.gateway';
import {
  nodeReadinessFiles,
  READINESS_MAX_OUTPUT_BYTES,
  type ReadSealedFile,
} from './readiness/readiness-seams';

const SUMMARY_PATH = '/etc/home-worker/live-stream-policy.summary.json';
const SUMMARY_MODE = 0o644;
const SUMMARY_OWNER_UID = 0;
const POLICY_VERSION = 2;
const DEFAULT_UDP_PORT_FIRST = 24_000;
const DEFAULT_UDP_PORT_LAST = 24_001;
const MIN_UDP_PORT = 1024;
const MAX_UDP_PORT = 65_535;
const DIGEST = /^[0-9a-f]{64}$/u;
const DIGITS = /^\d+$/u;
const INTERFACE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,14}$/u;
/** The same key set the installer writes and every privileged verifier accepts. */
const POLICY_KEYS = ['version', 'workerUid', 'streamUid', 'networks', 'udpPortFirst', 'udpPortLast', 'digest'];
/** The only prefixes an RTSP policy may bind, matching the root inspector. */
const PRIVATE_NETWORKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

export interface InstalledRtspPolicyStatusDependencies {
  inspector?: RtspPolicyInspector;
  files?: { readSealed: ReadSealedFile };
  env?: Record<string, string | undefined>;
}

interface PolicyDocument {
  digest: string;
  networks: readonly InstalledRtspNetwork[];
  udpPortFirst: number;
  udpPortLast: number;
}

/**
 * The installed RTSP policy as one projection every consumer shares.
 *
 * Three artifacts describe the policy — the private file root reads, the public
 * summary, and the environment this process was started with — and a reinstall
 * renames them one at a time. Readiness, install recovery, and Camera each
 * reading their own subset is how they end up disagreeing about a half-renamed
 * tuple, so all of them ask here and the three are cross-checked in one place:
 * the summary is opened through a single descriptor, its digest is recomputed
 * from every field rather than trusted, that digest and the CIDR/UDP projection
 * must equal what this process was started with, and only then does the fixed
 * root inspector get asked whether the installed networks are still the live
 * ones. Any disagreement fails closed.
 */
export class InstalledRtspPolicyStatusAdapter implements RtspPolicyStatusPort {
  private readonly logger = new Logger(InstalledRtspPolicyStatusAdapter.name);
  private readonly inspector: RtspPolicyInspector;
  private readonly files: { readSealed: ReadSealedFile };
  private readonly env: Record<string, string | undefined>;
  /** The last digest proven current; the synchronous fence has nothing else to trust. */
  private validated: string | null = null;

  constructor(dependencies: InstalledRtspPolicyStatusDependencies = {}) {
    this.inspector = dependencies.inspector ?? new RtspPolicyInspectorGateway();
    this.files = dependencies.files ?? nodeReadinessFiles;
    this.env = dependencies.env ?? process.env;
  }

  async inspect(): Promise<RtspPolicyStatus> {
    let check = 'public policy summary';
    try {
      const installed = await this.readInstalledPolicy();
      check = 'process environment';
      this.assertEnvironmentAgrees(installed);
      check = 'installed policy verdict';
      const verdict = await this.inspector.verifyInstalled();
      if (verdict.digest !== null && verdict.digest !== installed.digest) throw new Error('digest drift');
      if (!verdict.ready) {
        this.validated = null;
        if (verdict.reason !== 'policy-stale') throw new Error(verdict.reason);
        return { state: 'stale', digest: installed.digest, networks: verdict.networks };
      }
      if (!sameNetworks(verdict.networks, installed.networks)) throw new Error('projection drift');
      this.validated = installed.digest;
      return { state: 'ready', digest: installed.digest, networks: installed.networks };
    } catch {
      // Only the breadcrumb: the rejected policy, the helper's output, and the
      // environment all stay out of the log by never being carried this far.
      this.logger.warn(`Installed RTSP policy rejected: ${check}`);
      this.validated = null;
      return { state: 'unavailable', digest: null, networks: [] };
    }
  }

  async requireCurrent(): Promise<{ digest: string; networks: readonly InstalledRtspNetwork[] }> {
    const status = await this.inspect();
    if (status.state !== 'ready') throw new RtspPolicyUnavailableError(status.state);
    return { digest: status.digest, networks: status.networks };
  }

  assertDigest(expected: string): void {
    if (this.validated === null || this.validated !== expected) {
      throw new RtspPolicyDigestMismatchError(expected);
    }
  }

  private async readInstalledPolicy(): Promise<PolicyDocument> {
    const file = await this.files.readSealed(SUMMARY_PATH, READINESS_MAX_OUTPUT_BYTES);
    if (!file.isFile || file.mode !== SUMMARY_MODE || file.uid !== SUMMARY_OWNER_UID || file.nlink !== 1) {
      throw new Error('summary ownership or mode mismatch');
    }
    if (file.size > READINESS_MAX_OUTPUT_BYTES || file.content.length > READINESS_MAX_OUTPUT_BYTES) {
      throw new Error('summary too large');
    }
    return parsePolicyDocument(file.content);
  }

  private assertEnvironmentAgrees(installed: PolicyDocument): void {
    const raw = this.env.RTSP_ALLOWED_CIDRS;
    if (!raw) throw new Error('allowed CIDRs unset');
    const declared = raw.split(',').map((entry) => {
      const network = canonicalNetwork(entry.trim());
      if (network === null) throw new Error('allowed CIDRs malformed');
      return network.cidr;
    });
    const expected: string[] = [];
    for (const network of installed.networks) {
      if (!expected.includes(network.cidr)) expected.push(network.cidr);
    }
    if (declared.length !== expected.length || declared.some((cidr, index) => cidr !== expected[index])) {
      throw new Error('allowed CIDRs drifted');
    }
    if (this.env.RTSP_POLICY_DIGEST !== installed.digest) throw new Error('policy digest drifted');
    if (
      this.udpPort('RTSP_UDP_PORT_FIRST', DEFAULT_UDP_PORT_FIRST) !== installed.udpPortFirst ||
      this.udpPort('RTSP_UDP_PORT_LAST', DEFAULT_UDP_PORT_LAST) !== installed.udpPortLast
    ) {
      throw new Error('UDP range drifted');
    }
  }

  /** A blank setting means "unset" here exactly as it does in the installer. */
  private udpPort(key: 'RTSP_UDP_PORT_FIRST' | 'RTSP_UDP_PORT_LAST', fallback: number): number {
    const raw = this.env[key]?.trim();
    if (!raw) return fallback;
    if (!DIGITS.test(raw)) throw new Error('UDP range malformed');
    return Number(raw);
  }
}

function parsePolicyDocument(body: string): PolicyDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    throw new Error('summary unreadable');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('summary shape');
  const document = raw as Record<string, unknown>;
  const keys = Object.keys(document);
  if (keys.length !== POLICY_KEYS.length || !POLICY_KEYS.every((key) => keys.includes(key))) {
    throw new Error('summary shape');
  }
  if (document.version !== POLICY_VERSION) throw new Error('summary version');
  const workerUid = uid(document.workerUid);
  const streamUid = uid(document.streamUid);
  if (workerUid === streamUid) throw new Error('summary identity');
  const udpPortFirst = udpPort(document.udpPortFirst);
  const udpPortLast = udpPort(document.udpPortLast);
  if (udpPortFirst > udpPortLast) throw new Error('summary udp range');
  const networks = parseNetworks(document.networks);
  const digest = document.digest;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error('summary digest');
  const recomputed = policyDigest({ workerUid, streamUid, networks, udpPortFirst, udpPortLast });
  if (recomputed !== digest) throw new Error('summary digest');
  return { digest, networks, udpPortFirst, udpPortLast };
}

function parseNetworks(raw: unknown): readonly InstalledRtspNetwork[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('summary networks');
  const networks = raw.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('summary networks');
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).length !== 3) throw new Error('summary networks');
    const name = record.interface;
    if (typeof name !== 'string' || !INTERFACE.test(name) || name === 'lo') throw new Error('summary networks');
    const network = typeof record.cidr === 'string' ? canonicalNetwork(record.cidr) : null;
    // The digest covers the CIDR text itself, so an installed entry must already
    // be canonical; only the hand-editable environment is normalized on read.
    if (network === null || record.family !== network.family || network.cidr !== record.cidr) {
      throw new Error('summary networks');
    }
    return { entry: { family: network.family, cidr: network.cidr, interface: name }, key: sortKey(network, name) };
  });
  const keys = networks.map((network) => network.key);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index]) || new Set(keys).size !== keys.length) {
    throw new Error('summary order');
  }
  return networks.map((network) => network.entry);
}

/**
 * The installer's digest, recomputed field by field.
 *
 * The canonical encoding is compact JSON with sorted keys — spelled out here
 * because it must equal the Python `json.dumps(..., sort_keys=True)` the root
 * side hashes, byte for byte, for the two digests to be comparable at all.
 */
function policyDigest(policy: {
  workerUid: number;
  streamUid: number;
  networks: readonly InstalledRtspNetwork[];
  udpPortFirst: number;
  udpPortLast: number;
}): string {
  const networks = policy.networks
    .map((network) => `{"cidr":${JSON.stringify(network.cidr)},"family":${network.family},"interface":${JSON.stringify(network.interface)}}`)
    .join(',');
  const payload = `{"networks":[${networks}],"streamUid":${policy.streamUid}`
    + `,"udpPortFirst":${policy.udpPortFirst},"udpPortLast":${policy.udpPortLast}`
    + `,"version":${POLICY_VERSION},"workerUid":${policy.workerUid}}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

interface Network {
  family: 4 | 6;
  cidr: string;
  value: bigint;
  prefix: number;
}

/**
 * The canonical form of a private CIDR, or null when it is not one.
 *
 * Canonical means what the root side means by it — lowercase, RFC 5952
 * compressed, host bits clear — so that two spellings of one network compare
 * equal instead of reading as a policy drift.
 */
function canonicalNetwork(text: string): Network | null {
  const slash = text.lastIndexOf('/');
  if (slash <= 0) return null;
  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;
  if (!DIGITS.test(prefixText) || (prefixText.length > 1 && prefixText.startsWith('0'))) return null;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (prefix <= 0 || prefix > bits) return null;
  const value = addressValue(address, family);
  const hostBits = BigInt(bits - prefix);
  if (((value >> hostBits) << hostBits) !== value) return null;
  const network: Network = { family, cidr: `${canonicalAddress(address, family)}/${prefix}`, value, prefix };
  return PRIVATE_NETWORKS.some((candidate) => contains(candidate, network)) ? network : null;
}

function contains(candidate: string, network: Network): boolean {
  const slash = candidate.indexOf('/');
  const address = candidate.slice(0, slash);
  const family = isIP(address);
  if (family !== network.family) return false;
  const prefix = Number(candidate.slice(slash + 1));
  if (network.prefix < prefix) return false;
  const hostBits = BigInt((family === 4 ? 32 : 128) - prefix);
  return (network.value >> hostBits) === (addressValue(address, family) >> hostBits);
}

/** The WHATWG serializer applies the same RFC 5952 rules the root side does. */
function canonicalAddress(address: string, family: 4 | 6): string {
  return family === 4
    ? new URL(`http://${address}/`).hostname
    : new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

function addressValue(address: string, family: 4 | 6): bigint {
  if (family === 4) {
    return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  }
  const canonical = canonicalAddress(address, 6);
  const [leftText, rightText = ''] = canonical.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

/** Family, network bytes, prefix length, then interface — the canonical policy order. */
function sortKey(network: Network, name: string): string {
  const width = network.family === 4 ? 8 : 32;
  return `${network.family}:${network.value.toString(16).padStart(width, '0')}:${String(network.prefix).padStart(3, '0')}:${name}`;
}

function uid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('summary identity');
  return value;
}

function udpPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_UDP_PORT || value > MAX_UDP_PORT) {
    throw new Error('summary udp range');
  }
  return value;
}

function sameNetworks(left: readonly InstalledRtspNetwork[], right: readonly InstalledRtspNetwork[]): boolean {
  return left.length === right.length && left.every((network, index) =>
    network.family === right[index].family
    && network.cidr === right[index].cidr
    && network.interface === right[index].interface);
}
