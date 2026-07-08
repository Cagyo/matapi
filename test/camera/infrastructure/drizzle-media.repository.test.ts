import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { motionEvents } from '../../../src/database/schema';
import { AppDatabase } from '../../../src/database/database.module';
import { DrizzleMediaRepository } from '../../../src/camera/infrastructure/drizzle-media.repository';

describe('DrizzleMediaRepository.listAllMediaPaths', () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let repo: DrizzleMediaRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    repo = new DrizzleMediaRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns every non-null video and snapshot path, regardless of flags', async () => {
    db.insert(motionEvents)
      .values([
        {
          cameraId: null,
          startedAt: new Date('2030-01-01T00:00:00.000Z'),
          endedAt: new Date('2030-01-01T00:00:30.000Z'),
          videoPath: '/m/1.mp4',
          snapshotPath: '/m/1.jpg',
          uploadedToGdrive: false,
          gdriveFileId: null,
          localDeleted: false,
        },
        {
          cameraId: null,
          startedAt: new Date('2030-01-01T00:01:00.000Z'),
          endedAt: new Date('2030-01-01T00:01:30.000Z'),
          videoPath: '/m/2.mp4',
          snapshotPath: null,
          uploadedToGdrive: true,
          gdriveFileId: 'drive/2.mp4',
          localDeleted: false,
        },
        {
          cameraId: null,
          startedAt: new Date('2030-01-01T00:02:00.000Z'),
          endedAt: new Date('2030-01-01T00:02:30.000Z'),
          videoPath: null,
          snapshotPath: '/m/3.jpg',
          uploadedToGdrive: false,
          gdriveFileId: null,
          localDeleted: true,
        },
        {
          cameraId: null,
          startedAt: new Date('2030-01-01T00:03:00.000Z'),
          endedAt: new Date('2030-01-01T00:03:30.000Z'),
          videoPath: null,
          snapshotPath: null,
          uploadedToGdrive: true,
          gdriveFileId: 'drive/4.mp4',
          localDeleted: true,
        },
      ])
      .run();

    const paths = await repo.listAllMediaPaths();

    expect(paths.sort()).toEqual(['/m/1.jpg', '/m/1.mp4', '/m/2.mp4', '/m/3.jpg']);
  });
});
