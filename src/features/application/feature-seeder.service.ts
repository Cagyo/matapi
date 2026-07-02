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
      // Fix 5a: If all catalog features already exist in DB, skip seeding to preserve runtime state.
      if (existing.length >= FEATURE_CATALOG.length) {
        return;
      }

      const featuresFile = resolve(process.cwd(), 'features.json');
      if (!existsSync(featuresFile)) {
        return;
      }

      let enabledList: string[] = [];
      try {
        // Fix 5b: Try/catch around JSON.parse to prevent corrupt features.json from crashing NestJS boot
        const raw = readFileSync(featuresFile, 'utf-8');
        const parsed = JSON.parse(raw);
        enabledList = Array.isArray(parsed.enabled) ? parsed.enabled : [];
      } catch (err) {
        this.logger.warn(`Invalid features.json — skipping feature seeding: ${(err as Error).message}`);
        return;
      }

      // Fix 5a: Transaction wrapper so partial seeds do not permanently break feature state
      this.db.transaction((tx) => {
        // If partial state existed, clear it inside transaction before re-seeding
        if (existing.length > 0) {
          tx.delete(features).run();
        }
        for (const entry of FEATURE_CATALOG) {
          tx.insert(features).values({
            name: entry.name,
            enabled: enabledList.includes(entry.name),
            installed: enabledList.includes(entry.name),
          }).run();
        }
      });
      this.logger.log(`Successfully seeded ${FEATURE_CATALOG.length} features from features.json`);
    } catch (err) {
      this.logger.error(`Feature seeding failed: ${(err as Error).message}`, (err as Error).stack);
    }
  }
}
