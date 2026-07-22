import type { Feature } from './feature.entity';
import type {
  ActiveFeatureJob,
  FeatureAction,
  FeatureAttentionReason,
  ManageableFeatureName,
} from './manageable-feature';

export interface FeatureStatus {
  name: ManageableFeatureName;
  enabled: boolean;
  installed: boolean;
  ready: boolean;
  busy: boolean;
  attentionReason: FeatureAttentionReason | null;
  display:
    | 'not-installed'
    | 'installed-off'
    | 'enabled'
    | 'needs-attention'
    | 'installing';
  action: FeatureAction | null;
}

const LOCAL_GUIDANCE_REASONS = new Set<FeatureAttentionReason>([
  'inconsistent-state',
  'restart-required',
  'helper-update-required',
]);

export function deriveFeatureStatus(
  feature: Feature,
  activeJob: ActiveFeatureJob | null,
): FeatureStatus {
  const name = feature.name as ManageableFeatureName;
  if (
    activeJob?.feature === name &&
    (activeJob.status === 'queued' || activeJob.status === 'running')
  ) {
    return {
      name,
      installed: feature.installed,
      enabled: feature.enabled,
      ready: false,
      busy: true,
      attentionReason: feature.attentionReason,
      display: 'installing',
      action: null,
    };
  }

  const attentionReason =
    feature.attentionReason ??
    (feature.enabled && !feature.installed ? 'inconsistent-state' : null);
  if (attentionReason) {
    return {
      name,
      installed: feature.installed,
      enabled: feature.enabled,
      ready: false,
      busy: false,
      attentionReason,
      display: 'needs-attention',
      action: LOCAL_GUIDANCE_REASONS.has(attentionReason) ? null : 'verify',
    };
  }
  if (!feature.installed) {
    return {
      name,
      installed: false,
      enabled: false,
      ready: false,
      busy: false,
      attentionReason: null,
      display: 'not-installed',
      action: 'install',
    };
  }
  if (!feature.enabled) {
    return {
      name,
      installed: true,
      enabled: false,
      ready: true,
      busy: false,
      attentionReason: null,
      display: 'installed-off',
      action: 'enable',
    };
  }
  return {
    name,
    installed: true,
    enabled: true,
    ready: true,
    busy: false,
    attentionReason: null,
    display: 'enabled',
    action: 'disable',
  };
}
