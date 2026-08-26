import type { InstalledRtspNetwork } from '../../domain/ports/rtsp-policy-status.port';
import {
  defaultExecFile,
  READINESS_COMMAND_OPTIONS,
  READINESS_MAX_OUTPUT_BYTES,
  type FixedExecFile,
} from './readiness-seams';

/** The one root-owned executable the worker is allowed to ask about the policy. */
export const RTSP_POLICY_INSPECTOR = '/usr/lib/home-worker/live-stream-policy-inspector';
const VERIFY_INSTALLED = 'verify-installed';
const PROTOCOL_VERSION = 2;
const DIGEST = /^[0-9a-f]{64}$/u;
const INTERFACE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,14}$/u;

/** Every verdict the inspector is allowed to reach the worker with. */
export const RTSP_POLICY_INSPECTOR_REASONS = [
  'local-network-unavailable',
  'policy-stale',
  'policy-summary-invalid',
] as const;

export type RtspPolicyInspectorReason = (typeof RTSP_POLICY_INSPECTOR_REASONS)[number];

export type RtspPolicyInspectorVerdict =
  | { ready: true; reason: null; digest: string; networks: readonly InstalledRtspNetwork[] }
  | {
      ready: false;
      reason: RtspPolicyInspectorReason;
      digest: string | null;
      networks: readonly InstalledRtspNetwork[];
    };

export interface RtspPolicyInspector {
  verifyInstalled(): Promise<RtspPolicyInspectorVerdict>;
}

export interface RtspPolicyInspectorDependencies {
  execFile?: FixedExecFile;
}

/**
 * The worker's only channel to the root policy inspector.
 *
 * The command is fixed and argv-form: nothing a Telegram user, a camera source,
 * or the environment says can widen or redirect what root inspects. Only the
 * structurally valid verdict leaves this class — raw stdout and stderr are
 * discarded here rather than carried into a log line or an error message, so a
 * future helper change cannot start leaking policy internals through them.
 */
export class RtspPolicyInspectorGateway implements RtspPolicyInspector {
  private readonly execFile: FixedExecFile;

  constructor(dependencies: RtspPolicyInspectorDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
  }

  async verifyInstalled(): Promise<RtspPolicyInspectorVerdict> {
    let stdout: string;
    try {
      ({ stdout } = await this.execFile(RTSP_POLICY_INSPECTOR, [VERIFY_INSTALLED], READINESS_COMMAND_OPTIONS));
    } catch {
      // The rejection carries the helper's stdout and stderr; dropping it here
      // is what keeps them out of every log line and message downstream.
      throw new Error('rtsp policy inspector did not answer');
    }
    if (stdout.length > READINESS_MAX_OUTPUT_BYTES) throw new Error('rtsp policy inspector answer too large');
    return parseVerdict(stdout);
  }
}

function parseVerdict(stdout: string): RtspPolicyInspectorVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('rtsp policy inspector answer unreadable');
  }
  if (!isRecord(raw) || raw.version !== PROTOCOL_VERSION) throw new Error('rtsp policy inspector answer unreadable');
  const networks = parseNetworks(raw.networks);
  const digest = raw.digest === null || (typeof raw.digest === 'string' && DIGEST.test(raw.digest))
    ? raw.digest
    : undefined;
  if (digest === undefined) throw new Error('rtsp policy inspector answer unreadable');
  if (raw.ready === true) {
    if (raw.reason !== null || digest === null) throw new Error('rtsp policy inspector answer unreadable');
    return { ready: true, reason: null, digest, networks };
  }
  if (raw.ready !== false) throw new Error('rtsp policy inspector answer unreadable');
  const reason = RTSP_POLICY_INSPECTOR_REASONS.find((candidate) => candidate === raw.reason);
  if (reason === undefined) throw new Error('rtsp policy inspector answer unreadable');
  return { ready: false, reason, digest, networks };
}

function parseNetworks(raw: unknown): readonly InstalledRtspNetwork[] {
  if (!Array.isArray(raw)) throw new Error('rtsp policy inspector answer unreadable');
  return raw.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 3) throw new Error('rtsp policy inspector answer unreadable');
    const { family, cidr, interface: name } = entry;
    if ((family !== 4 && family !== 6) || typeof cidr !== 'string' || typeof name !== 'string' || !INTERFACE.test(name)) {
      throw new Error('rtsp policy inspector answer unreadable');
    }
    return { family, cidr, interface: name };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
