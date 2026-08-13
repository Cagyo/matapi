import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { DrizzleArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/drizzle-archive-provider-state.repository';

describe('DrizzleArchiveProviderStateRepository', () => {
  let sqlite: Database.Database;
  let repository: DrizzleArchiveProviderStateRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    repository = new DrizzleArchiveProviderStateRepository(db);
  });

  afterEach(() => sqlite.close());

  it('fences provider-state writers by singleton revision', async () => {
    const state = await repository.load();
    expect(await repository.activateGeneration(state.revision, 'generation-1', 100)).toBe(true);
    expect(await repository.activateGeneration(state.revision, 'generation-2', 101)).toBe(false);
    expect(await repository.load()).toMatchObject({ revision: 1, generationId: 'generation-1', updatedAtMs: 100 });
  });
});
