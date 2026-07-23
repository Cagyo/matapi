import type { FeatureInstallRequestV1 } from '../manageable-feature';

export const FEATURE_INSTALL_REQUEST = Symbol('FEATURE_INSTALL_REQUEST');

export interface FeatureInstallRequestPort {
  publish(request: FeatureInstallRequestV1): Promise<'published' | 'already-published'>;
}
