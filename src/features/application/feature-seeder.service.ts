import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppDatabase, DB } from '../../database/database.module';
import { features } from '../../database/schema';
import { FEATURE_CATALOG } from '../domain/feature-catalog';
import { FEATURE_QUERY, FeatureQueryPort } from '../domain/ports/feature-query.port';

/**
 * Seeds the `features` database table from `features.json` on initial worker boot.
 * Handles edge cases: partial seed recovery & atomic transaction (Fix 5a),
 * and malformed JSON crash protection (Fix 5b).
 */
@Injectable()
export class FeatureSeederService implements OnModuleInit {
  private readonly logger = new Logger(FeatureSeederService.name);

  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(FEATURE_QUERY) private readonly featureQuery: FeatureQueryPort,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const existing = await this.featureQuery.listAll();
      const existingNames = new Set(existing.map((feature) => feature.name));
      const missingCatalogEntries = FEATURE_CATALOG.filter(
        (entry) => !existingNames.has(entry.name),
      );
      if (missingCatalogEntries.length === 0) {
        return;
      }

      let enabledList: string[] = [];
      if (existing.length === 0) {
        const featuresFile = resolve(process.cwd(), 'features.json');
        if (!existsSync(featuresFile)) {
          return;
        }

        try {
          // Fix 5b: Try/catch around JSON.parse to prevent corrupt features.json from crashing NestJS boot
          const raw = readFileSync(featuresFile, 'utf-8');
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null && 'enabled' in parsed) {
            const { enabled } = parsed as { enabled?: unknown };
            if (Array.isArray(enabled)) {
              enabledList = enabled.filter((item: unknown): item is string => typeof item === 'string');
            }
          }
        } catch (err) {
          this.logger.warn(`Invalid features.json — skipping feature seeding: ${(err as Error).message}`);
          return;
        }
      }

      // Insert only missing catalogue entries so upgrades never reset saved state.
      this.db.transaction((tx) => {
        for (const entry of missingCatalogEntries) {
          const selectedOnFirstInstall = existing.length === 0 && enabledList.includes(entry.name);
          tx.insert(features).values({
            name: entry.name,
            enabled: selectedOnFirstInstall,
            installed: selectedOnFirstInstall,
          }).run();
        }
      });
      this.logger.log(`Successfully seeded ${missingCatalogEntries.length} missing features`);
    } catch (err) {
      this.logger.error(`Feature seeding failed: ${(err as Error).message}`, (err as Error).stack);
    }
  }
}
