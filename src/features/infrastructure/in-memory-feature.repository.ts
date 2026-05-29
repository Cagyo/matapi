import { Feature } from '../domain/feature.entity';
import { FeatureNotInstalledError } from '../domain/errors/feature-not-installed.error';
import { FeatureRepositoryPort } from '../domain/ports/feature-repository.port';

/** In-memory `FeatureRepositoryPort` for tests and dev. */
export class InMemoryFeatureRepository implements FeatureRepositoryPort {
  constructor(private features: Feature[] = []) {}

  async findByName(name: string): Promise<Feature | null> {
    return this.features.find((f) => f.name === name) ?? null;
  }

  async setEnabled(name: string, enabled: boolean): Promise<Feature> {
    const feature = this.features.find((f) => f.name === name);
    if (!feature) throw new FeatureNotInstalledError(name);
    feature.enabled = enabled;
    return { ...feature };
  }

  seed(features: Feature[]): void {
    this.features = features;
  }
}
