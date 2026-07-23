import type { ManageableFeatureName } from '../../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';

/** Fixed canonical router; callers cannot select an arbitrary readiness command. */
export class FeatureReadinessRouter implements FeatureReadinessPort {
  constructor(private readonly adapters: Record<ManageableFeatureName, FeatureReadinessPort>) {}

  verify(name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    return this.adapters[name].verify(name);
  }
}
