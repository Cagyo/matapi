import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { features } from '../../database/schema';
import { Feature } from '../domain/feature.entity';
import { FeatureNotInstalledError } from '../domain/errors/feature-not-installed.error';
import { FeatureRepositoryPort } from '../domain/ports/feature-repository.port';

type FeatureRow = typeof features.$inferSelect;

/** Production `FeatureRepositoryPort` over the SQLite `features` table. */
@Injectable()
export class DrizzleFeatureRepository implements FeatureRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async findByName(name: string): Promise<Feature | null> {
    const row = this.db
      .select()
      .from(features)
      .where(eq(features.name, name))
      .get();
    return row ? toFeature(row) : null;
  }

  async setEnabled(name: string, enabled: boolean): Promise<Feature> {
    const [row] = this.db
      .update(features)
      .set({ enabled })
      .where(eq(features.name, name))
      .returning()
      .all();
    if (!row) throw new FeatureNotInstalledError(name);
    return toFeature(row);
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
