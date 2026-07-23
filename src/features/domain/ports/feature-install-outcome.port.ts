import type { FeatureInstallJob } from '../manageable-feature';

/** Late-bound terminal delivery seam. Feature application code never imports Telegram. */
export interface FeatureInstallOutcomePort {
  /** Informational copy sent before a restart; it must not complete the receipt. */
  notifyPreRestart(job: FeatureInstallJob): Promise<void>;
  /** Exact terminal delivery, normally performed after the restarted worker boots. */
  notify(job: FeatureInstallJob): Promise<void>;
}

export const FEATURE_INSTALL_OUTCOME_REGISTRY = Symbol('FEATURE_INSTALL_OUTCOME_REGISTRY');

export interface FeatureInstallOutcomeRegistryPort {
  register(listener: FeatureInstallOutcomePort): void;
  notifyPreRestart(job: FeatureInstallJob): Promise<void>;
  notify(job: FeatureInstallJob): Promise<void>;
}
