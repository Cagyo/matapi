import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { features } from '../../database/schema';
import { Feature } from '../domain/feature.entity';
import { FeatureNotInstalledError } from '../domain/errors/feature-not-installed.error';
import { FeatureRepositoryPort } from '../domain/ports/feature-repository.port';
import type { FeatureAttentionReason, ManageableFeatureName } from '../domain/manageable-feature';

type FeatureRow = typeof features.$inferSelect;

/** Production `FeatureRepositoryPort` over the SQLite `features` table. */
@Injectable()
export class DrizzleFeatureRepository implements FeatureRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async insertMissing(rows: readonly { name: ManageableFeatureName; installed: boolean; enabled: boolean }[]): Promise<void> {
    if (rows.length === 0) return;
    this.db.transaction((tx) => {
      tx.insert(features).values([...rows]).onConflictDoNothing().run();
    });
  }

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

  async compareAndSetEnabled(input: {
    name: ManageableFeatureName;
    expected: { installed: boolean; enabled: boolean; attentionReason: FeatureAttentionReason | null };
    enabled: boolean;
  }): Promise<Feature | null> {
    const [row] = this.db
      .update(features)
      .set({ enabled: input.enabled })
      .where(and(
        eq(features.name, input.name),
        booleanMatches(features.installed, input.expected.installed),
        booleanMatches(features.enabled, input.expected.enabled),
        input.expected.attentionReason === null
          ? isNull(features.attentionReason)
          : eq(features.attentionReason, input.expected.attentionReason),
      ))
      .returning()
      .all();
    return row ? toFeature(row) : null;
  }

  async setVerified(input: {
    name: ManageableFeatureName;
    installed: boolean;
    attentionReason: FeatureAttentionReason | null;
  }): Promise<Feature> {
    const [row] = this.db
      .update(features)
      .set({ installed: input.installed, attentionReason: input.attentionReason })
      .where(eq(features.name, input.name))
      .returning()
      .all();
    if (!row) throw new FeatureNotInstalledError(input.name);
    return toFeature(row);
  }

  async setAttention(name: ManageableFeatureName, reason: FeatureAttentionReason | null): Promise<Feature> {
    const [row] = this.db
      .update(features)
      .set({ attentionReason: reason })
      .where(eq(features.name, name))
      .returning()
      .all();
    if (!row) throw new FeatureNotInstalledError(name);
    return toFeature(row);
  }
}

function booleanMatches(
  column: typeof features.enabled | typeof features.installed,
  expected: boolean,
) {
  return expected ? eq(column, true) : or(eq(column, false), isNull(column));
}

function toFeature(row: FeatureRow): Feature {
  return {
    name: row.name,
    enabled: row.enabled ?? false,
    installed: row.installed ?? false,
    config: (row.config as Record<string, unknown> | null) ?? null,
    attentionReason: row.attentionReason as FeatureAttentionReason | null,
  };
}
