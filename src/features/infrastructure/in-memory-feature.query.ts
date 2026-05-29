import { Feature } from '../domain/feature.entity';
import { FeatureQueryPort } from '../domain/ports/feature-query.port';

/** In-memory `FeatureQueryPort` for tests and dev. */
export class InMemoryFeatureQuery implements FeatureQueryPort {
  constructor(private features: Feature[] = []) {}

  async listAll(): Promise<Feature[]> {
    return [...this.features].sort((a, b) => a.name.localeCompare(b.name));
  }

  seed(features: Feature[]): void {
    this.features = features;
  }
}
