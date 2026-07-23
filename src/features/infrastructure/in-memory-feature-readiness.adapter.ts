import type { ManageableFeatureName } from '../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../domain/ports/feature-readiness.port';

/** In-memory readiness adapter for use-case tests and mock mode. */
export class InMemoryFeatureReadinessAdapter implements FeatureReadinessPort {
  private readonly results = new Map<ManageableFeatureName, FeatureReadinessResult>();

  set(name: ManageableFeatureName, result: FeatureReadinessResult): void {
    this.results.set(name, result);
  }

  async verify(name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    return this.results.get(name) ?? { ready: true, restartScope: 'worker' };
  }
}
