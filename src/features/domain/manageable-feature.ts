export const MANAGEABLE_FEATURE_NAMES = [
  'digital',
  'uart',
  'zigbee',
  'motion',
  'rtsp',
] as const;

export const LEGACY_FEATURE_NAMES = ['neobox', '4g'] as const;

export type ManageableFeatureName = (typeof MANAGEABLE_FEATURE_NAMES)[number];
export type FeatureAction = 'install' | 'enable' | 'disable' | 'verify';
export type RestartScope = 'worker' | 'supervisor' | 'host';
export type FeatureAttentionReason =
  | 'inconsistent-state'
  | 'readiness-failed'
  | 'install-failed'
  | 'partial-state-uncertain'
  | 'restart-required'
  | 'helper-update-required';
/**
 * Every cause an install can end with, spelled once. The privileged routine
 * reserves one exit status per RTSP-specific cause and the helper collapses
 * anything else to `dependency-install-failed`, so this union stays closed and
 * carries no diagnostics: raw route output and package errors belong to the
 * root journal only.
 */
export const FEATURE_INSTALL_FAILURE_CODES = [
  'request-invalid',
  'request-publish-failed',
  'local-network-unavailable',
  'network-policy-generation-failed',
  'dependency-install-failed',
  'privileged-verification-failed',
  'application-verification-failed',
  'partial-state-uncertain',
  'helper-version-mismatch',
  'result-invalid',
  'interrupted',
] as const;

export type FeatureInstallFailureCode = (typeof FEATURE_INSTALL_FAILURE_CODES)[number];

export interface FeatureInstallRequestV1 {
  version: 1;
  jobId: string;
  feature: ManageableFeatureName;
}

export type FeatureInstallResultV1 = {
  version: 1;
  jobId: string;
  feature: ManageableFeatureName;
  privilegedReady: boolean;
  restartScope: RestartScope | null;
} &
  (
    | { outcome: 'succeeded'; failureCode: null }
    | { outcome: 'failed'; failureCode: FeatureInstallFailureCode }
  );

export type FeatureInstallJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface FeatureInstallJob {
  id: string;
  feature: ManageableFeatureName;
  status: FeatureInstallJobStatus;
  activeSlot: 1 | null;
  requestedByUserId: number;
  requestedInChatId: number;
  workflowReceiptId: string;
  previousInstalled: boolean;
  previousEnabled: boolean;
  restartScope: RestartScope | null;
  failureCode: FeatureInstallFailureCode | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ActiveFeatureJob = Pick<FeatureInstallJob, 'id' | 'feature' | 'status'>;

export interface CreateFeatureInstallJob {
  id: string;
  feature: ManageableFeatureName;
  requestedByUserId: number;
  requestedInChatId: number;
  workflowReceiptId: string;
  expected: { installed: boolean; enabled: boolean };
  now: Date;
}

const JOB_ID = /^[A-Za-z0-9_-]{16}$/;
const FAILURE_CODES = new Set<FeatureInstallFailureCode>(FEATURE_INSTALL_FAILURE_CODES);

export function isManageableFeature(
  value: unknown,
): value is ManageableFeatureName {
  return (
    typeof value === 'string' &&
    MANAGEABLE_FEATURE_NAMES.includes(value as ManageableFeatureName)
  );
}

export function parseFeatureInstallResult(raw: string): FeatureInstallResultV1 {
  if (Buffer.byteLength(raw, 'utf8') > 4_096) {
    throw new RangeError('Feature result exceeds 4096 bytes');
  }

  rejectDuplicateObjectKeys(raw);
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new RangeError('Feature result must be an object');

  const keys = Object.keys(value).sort();
  const expected = [
    'failureCode',
    'feature',
    'jobId',
    'outcome',
    'privilegedReady',
    'restartScope',
    'version',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new RangeError('Feature result has unknown or missing keys');
  }
  if (
    value.version !== 1 ||
    typeof value.jobId !== 'string' ||
    !JOB_ID.test(value.jobId) ||
    !isManageableFeature(value.feature)
  ) {
    throw new RangeError('Feature result identity is invalid');
  }
  if (typeof value.privilegedReady !== 'boolean') {
    throw new RangeError('Feature result readiness is invalid');
  }
  if (
    value.restartScope !== null &&
    value.restartScope !== 'worker' &&
    value.restartScope !== 'supervisor' &&
    value.restartScope !== 'host'
  ) {
    throw new RangeError('Feature result restart scope is invalid');
  }
  if (value.outcome === 'succeeded' && value.failureCode === null) {
    if (!value.privilegedReady || value.restartScope === null) {
      throw new RangeError('Successful feature result is incomplete');
    }
    return value as FeatureInstallResultV1;
  }
  if (
    value.outcome === 'failed' &&
    FAILURE_CODES.has(value.failureCode as FeatureInstallFailureCode) &&
    value.privilegedReady === false &&
    value.restartScope === null
  ) {
    return value as FeatureInstallResultV1;
  }
  throw new RangeError('Feature result outcome is invalid');
}

/**
 * The installer accepts only this tiny, closed wire format.  JSON.parse alone
 * would silently accept duplicate names, so reject them before parsing.
 */
export function parseFeatureInstallRequest(raw: string): FeatureInstallRequestV1 {
  if (Buffer.byteLength(raw, 'utf8') > 4_096) {
    throw new RangeError('Feature request exceeds 4096 bytes');
  }
  rejectDuplicateObjectKeys(raw);
  const value: unknown = JSON.parse(raw);
  return assertFeatureInstallRequest(value);
}

/** Validates an in-memory request before it can influence a spool filename. */
export function assertFeatureInstallRequest(value: unknown): FeatureInstallRequestV1 {
  if (!isRecord(value)) throw new RangeError('Feature request must be an object');
  const keys = Object.keys(value).sort();
  const expected = ['feature', 'jobId', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new RangeError('Feature request has unknown or missing keys');
  }
  if (value.version !== 1 || typeof value.jobId !== 'string' || !JOB_ID.test(value.jobId) || !isManageableFeature(value.feature)) {
    throw new RangeError('Feature request identity is invalid');
  }
  return { version: 1, jobId: value.jobId, feature: value.feature };
}

function rejectDuplicateObjectKeys(raw: string): void {
  const keys = new Set<string>();
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '{' || char === '[') { depth += 1; continue; }
    if (char === '}' || char === ']') { depth -= 1; continue; }
    if (char !== '"' || depth !== 1) continue;
    const start = index;
    index += 1;
    for (; index < raw.length; index += 1) {
      if (raw[index] === '\\') { index += 1; continue; }
      if (raw[index] === '"') break;
    }
    if (index >= raw.length) return;
    let cursor = index + 1;
    while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;
    if (raw[cursor] !== ':') continue;
    const key = JSON.parse(raw.slice(start, index + 1)) as string;
    if (keys.has(key)) throw new RangeError('Feature payload has duplicate keys');
    keys.add(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
