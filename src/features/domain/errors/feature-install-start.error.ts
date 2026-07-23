import type { ManageableFeatureName } from '../manageable-feature';

/** The request could not be durably handed off to the fixed installer. */
export class FeatureInstallStartError extends Error {
  readonly code = 'FEATURE_INSTALL_START_FAILED' as const;

  constructor(readonly feature: ManageableFeatureName) {
    super('Feature installation could not be started');
    this.name = 'FeatureInstallStartError';
  }
}
