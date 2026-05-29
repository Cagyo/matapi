import { Inject, Injectable } from '@nestjs/common';
import { FEATURE_CATALOG } from '../domain/feature-catalog';
import { FeatureStatus } from '../domain/feature-status';
import {
  FEATURE_QUERY,
  FeatureQueryPort,
} from '../domain/ports/feature-query.port';

/**
 * Spec 17 — `/feature list` (admin only). Merges the fixed feature catalogue
 * with persisted state, so every catalogue entry is reported even when the
 * `features` table has no row for it yet (rendered as not installed).
 */
@Injectable()
export class ListFeaturesUseCase {
  constructor(
    @Inject(FEATURE_QUERY) private readonly features: FeatureQueryPort,
  ) {}

  async execute(): Promise<FeatureStatus[]> {
    const rows = await this.features.listAll();
    const byName = new Map(rows.map((row) => [row.name, row]));
    return FEATURE_CATALOG.map((entry) => {
      const row = byName.get(entry.name);
      return {
        name: entry.name,
        description: entry.description,
        enabled: row?.enabled ?? false,
        installed: row?.installed ?? false,
      };
    });
  }
}
