import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FEATURE_CATALOG } from '../domain/feature-catalog';
import { FEATURE_QUERY, type FeatureQueryPort } from '../domain/ports/feature-query.port';
import { FEATURE_REPOSITORY, type FeatureRepositoryPort } from '../domain/ports/feature-repository.port';
import { FEATURE_SEED_CONFIG, type FeatureSeedConfigPort } from '../domain/ports/feature-seed-config.port';

/** Seeds absent catalogue rows without allowing unverified configuration to mark success. */
@Injectable()
export class FeatureSeederService implements OnModuleInit {
  private readonly logger = new Logger(FeatureSeederService.name);

  constructor(
    @Inject(FEATURE_SEED_CONFIG) private readonly config: FeatureSeedConfigPort,
    @Inject(FEATURE_QUERY) private readonly query: FeatureQueryPort,
    @Inject(FEATURE_REPOSITORY) private readonly repository: FeatureRepositoryPort,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.query.listAll();
      const existingNames = new Set(existing.map((feature) => feature.name));
      const missing = FEATURE_CATALOG.filter((entry) => !existingNames.has(entry.name));
      if (missing.length === 0) return;

      const verifiedEnabled = existing.length === 0 ? await this.config.loadEnabled() : [];
      const enabled = new Set(verifiedEnabled ?? []);
      await this.repository.insertMissing(missing.map((entry) => ({
        name: entry.name,
        installed: enabled.has(entry.name),
        enabled: enabled.has(entry.name),
      })));
      this.logger.log(`Seeded ${missing.length} missing feature catalogue rows`);
    } catch (error) {
      const cause = error as Error;
      this.logger.error(`Feature seeding failed: ${cause.message}`, cause.stack);
    }
  }
}
