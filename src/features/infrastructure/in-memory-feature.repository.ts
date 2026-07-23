import { Feature } from '../domain/feature.entity';
import { FeatureNotInstalledError } from '../domain/errors/feature-not-installed.error';
import type { FeatureAttentionReason, ManageableFeatureName } from '../domain/manageable-feature';
import { FeatureRepositoryPort } from '../domain/ports/feature-repository.port';

/** In-memory `FeatureRepositoryPort` for tests and dev. */
export class InMemoryFeatureRepository implements FeatureRepositoryPort {
  constructor(private features: Feature[] = []) {}

  async insertMissing(rows: readonly { name: ManageableFeatureName; installed: boolean; enabled: boolean }[]): Promise<void> {
    for (const row of rows) {
      if (this.features.some((feature) => feature.name === row.name)) continue;
      this.features.push({ ...row, config: null, attentionReason: null });
    }
  }

  async findByName(name: string): Promise<Feature | null> {
    const feature = this.features.find((f) => f.name === name);
    return feature ? { ...feature } : null;
  }

  async setEnabled(name: string, enabled: boolean): Promise<Feature> {
    const feature = this.features.find((f) => f.name === name);
    if (!feature) throw new FeatureNotInstalledError(name);
    feature.enabled = enabled;
    return { ...feature };
  }

  async compareAndSetEnabled(input: {
    name: ManageableFeatureName;
    expected: { installed: boolean; enabled: boolean; attentionReason: FeatureAttentionReason | null };
    enabled: boolean;
  }): Promise<Feature | null> {
    const feature = this.features.find((candidate) => candidate.name === input.name);
    if (!feature
      || feature.installed !== input.expected.installed
      || feature.enabled !== input.expected.enabled
      || feature.attentionReason !== input.expected.attentionReason) return null;
    feature.enabled = input.enabled;
    return { ...feature };
  }

  async setVerified(input: {
    name: ManageableFeatureName;
    installed: boolean;
    attentionReason: FeatureAttentionReason | null;
  }): Promise<Feature> {
    const feature = this.features.find((candidate) => candidate.name === input.name);
    if (!feature) throw new FeatureNotInstalledError(input.name);
    feature.installed = input.installed;
    feature.attentionReason = input.attentionReason;
    return { ...feature };
  }

  async setAttention(name: ManageableFeatureName, reason: FeatureAttentionReason | null): Promise<Feature> {
    const feature = this.features.find((candidate) => candidate.name === name);
    if (!feature) throw new FeatureNotInstalledError(name);
    feature.attentionReason = reason;
    return { ...feature };
  }

  seed(features: Feature | Feature[]): void {
    this.features = (Array.isArray(features) ? features : [features]).map((feature) => ({ ...feature }));
  }
}
