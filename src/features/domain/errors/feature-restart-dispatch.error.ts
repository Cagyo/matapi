import type {
  ManageableFeatureName,
  RestartScope,
} from '../manageable-feature';

export class FeatureRestartDispatchError extends Error {
  readonly code = 'FEATURE_RESTART_DISPATCH_FAILED' as const;

  constructor(
    readonly feature: ManageableFeatureName,
    readonly scope: RestartScope,
  ) {
    super('Feature state changed but restart dispatch failed');
    this.name = 'FeatureRestartDispatchError';
  }
}
