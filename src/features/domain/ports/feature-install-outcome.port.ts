import type { FeatureInstallJob } from '../manageable-feature';

/** Late-bound terminal delivery seam. Feature application code never imports Telegram. */
export interface FeatureInstallOutcomePort {
  notify(job: FeatureInstallJob): Promise<void>;
}

export const FEATURE_INSTALL_OUTCOME_REGISTRY = Symbol('FEATURE_INSTALL_OUTCOME_REGISTRY');

export interface FeatureInstallOutcomeRegistryPort {
  register(listener: FeatureInstallOutcomePort): void;
  notify(job: FeatureInstallJob): Promise<void>;
}
