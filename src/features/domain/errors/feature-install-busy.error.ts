import type { ManageableFeatureName } from '../manageable-feature';

export class FeatureInstallBusyError extends Error {
  readonly code = 'FEATURE_INSTALL_BUSY' as const;

  constructor(readonly activeFeature: ManageableFeatureName) {
    super('A feature installation is already active');
    this.name = 'FeatureInstallBusyError';
  }
}
