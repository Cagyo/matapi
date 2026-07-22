import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../../src/database/database.module';
import { features } from '../../../src/database/schema';
import { DrizzleFeatureQuery } from '../../../src/features/infrastructure/drizzle-feature.query';
import { DrizzleFeatureRepository } from '../../../src/features/infrastructure/drizzle-feature.repository';

describe('DrizzleFeatureQuery', () => {
  let sqlite: Database.Database;
  let db: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './migrations' });
  });

  afterEach(() => sqlite.close());

  it('reads attention written through the production feature repository', async () => {
    db.insert(features).values({
      name: 'motion',
      installed: true,
      enabled: true,
      config: null,
      attentionReason: null,
    }).run();
    const repository = new DrizzleFeatureRepository(db);
    const query = new DrizzleFeatureQuery(db);

    await repository.setAttention('motion', 'partial-state-uncertain');

    await expect(query.listAll()).resolves.toEqual([
      expect.objectContaining({
        name: 'motion',
        attentionReason: 'partial-state-uncertain',
      }),
    ]);
  });
});
