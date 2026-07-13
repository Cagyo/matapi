export const FEATURE_DISABLE_LIFECYCLE = Symbol('FEATURE_DISABLE_LIFECYCLE');

export interface FeatureDisableLifecyclePort {
  beforeDisable(name: string): Promise<void>;
}

export interface FeatureDisableLifecycleRegistryPort
  extends FeatureDisableLifecyclePort {
  register(lifecycle: FeatureDisableLifecyclePort): void;
}
