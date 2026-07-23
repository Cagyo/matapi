import type { FeatureInstallResultV1, ManageableFeatureName } from '../manageable-feature';

export const FEATURE_INSTALL_RESULT = Symbol('FEATURE_INSTALL_RESULT');

export interface FeatureInstallResultPort {
  readState(jobId: string, feature: ManageableFeatureName): Promise<
    | { kind: 'absent' }
    | { kind: 'running' }
    | { kind: 'terminal'; result: FeatureInstallResultV1 }
  >;
  removeTerminal(jobId: string): Promise<void>;
}
