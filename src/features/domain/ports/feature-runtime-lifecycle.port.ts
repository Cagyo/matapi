import type { ManageableFeatureName } from '../manageable-feature';

export const FEATURE_RUNTIME_LIFECYCLE = Symbol('FEATURE_RUNTIME_LIFECYCLE');

/** Stops and reloads the runtime work owned by one manageable feature. */
export interface FeatureRuntimeLifecyclePort {
  beforeDisable(): Promise<void>;
  afterEnable(): Promise<void>;
}

/** Feature-keyed runtime lifecycle registration for composition roots. */
export interface FeatureRuntimeLifecycleRegistryPort {
  register(name: ManageableFeatureName, lifecycle: FeatureRuntimeLifecyclePort): void;
  beforeDisable(name: ManageableFeatureName): Promise<void>;
  afterEnable(name: ManageableFeatureName): Promise<void>;
}
