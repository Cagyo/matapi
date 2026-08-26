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
  /**
   * An explicit extra action offered next to the primary one. Only an already
   * installed RTSP feature has one: its network policy is bound to the
   * interfaces present at install time, so moving the Pi needs a deliberate
   * reinstall rather than a silent widening of the installed policy.
   */
  secondaryAction: Extract<FeatureAction, 'reinstall'> | null;
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
  const reinstallable = name === 'rtsp' && feature.installed ? ('reinstall' as const) : null;
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
      secondaryAction: null,
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
      secondaryAction: reinstallable,
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
      secondaryAction: null,
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
      secondaryAction: reinstallable,
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
    secondaryAction: reinstallable,
  };
}
