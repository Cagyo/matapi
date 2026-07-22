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
export type FeatureInstallFailureCode =
  | 'request-invalid'
  | 'request-publish-failed'
  | 'dependency-install-failed'
  | 'privileged-verification-failed'
  | 'application-verification-failed'
  | 'partial-state-uncertain'
  | 'helper-version-mismatch'
  | 'result-invalid'
  | 'interrupted';

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
const FAILURE_CODES = new Set<FeatureInstallFailureCode>([
  'request-invalid',
  'request-publish-failed',
  'dependency-install-failed',
  'privileged-verification-failed',
  'application-verification-failed',
  'partial-state-uncertain',
  'helper-version-mismatch',
  'result-invalid',
  'interrupted',
]);

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
    FAILURE_CODES.has(value.failureCode as FeatureInstallFailureCode)
  ) {
    return value as FeatureInstallResultV1;
  }
  throw new RangeError('Feature result outcome is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
