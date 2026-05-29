import { Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { features } from '../../database/schema';
import { Feature } from '../domain/feature.entity';
import { FeatureQueryPort } from '../domain/ports/feature-query.port';

type FeatureRow = typeof features.$inferSelect;

/** Production `FeatureQueryPort` over the SQLite `features` table. */
@Injectable()
export class DrizzleFeatureQuery implements FeatureQueryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async listAll(): Promise<Feature[]> {
    return this.db
      .select()
      .from(features)
      .orderBy(asc(features.name))
      .all()
      .map((row) => toFeature(row));
  }
}

function toFeature(row: FeatureRow): Feature {
  return {
    name: row.name,
    enabled: row.enabled ?? false,
    installed: row.installed ?? false,
    config: (row.config as Record<string, unknown> | null) ?? null,
  };
}
