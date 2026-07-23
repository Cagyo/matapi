import type { FeatureInstallRequestV1 } from '../manageable-feature';

export const FEATURE_INSTALL_REQUEST = Symbol('FEATURE_INSTALL_REQUEST');

export interface FeatureInstallRequestPort {
  publish(request: FeatureInstallRequestV1): Promise<'published' | 'already-published'>;

  /**
   * Removes this exact request only while the helper has not claimed it.
   * `false` means the request was absent, claimed, or no longer exactly ours.
   */
  cancelUnclaimed(request: FeatureInstallRequestV1): Promise<boolean>;
}
