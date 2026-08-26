import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { motionEvents } from '../../../src/database/schema';
import { AppDatabase } from '../../../src/database/database.module';
import { DrizzleMediaRepository } from '../../../src/camera/infrastructure/drizzle-media.repository';
import { cameraNameKey } from '../../../src/camera/domain/camera-name-key';

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

describe('DrizzleMediaRepository browse queries', () => {
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

  function insertEvent(idOffset: number, startedAt: string): void {
    db.insert(motionEvents)
      .values({
        cameraId: null,
        startedAt: new Date(startedAt),
        endedAt: new Date(new Date(startedAt).getTime() + 30_000),
        videoPath: `/m/${idOffset}.mp4`,
        snapshotPath: null,
        uploadedToGdrive: false,
        gdriveFileId: null,
        localDeleted: false,
      })
      .run();
  }

  it('lists latest events newest first with the requested raw limit', async () => {
    insertEvent(1, '2026-04-08T12:00:00');
    insertEvent(2, '2026-04-08T12:05:00');
    insertEvent(3, '2026-04-08T12:10:00');

    const rows = await repo.listLatestEvents(2);

    expect(rows.map((e) => e.videoPath)).toEqual(['/m/3.mp4', '/m/2.mp4']);
  });

  it('lists started-between events newest first and excludes the end boundary', async () => {
    insertEvent(1, '2026-04-08T17:59:59');
    insertEvent(2, '2026-04-08T18:00:00');
    insertEvent(3, '2026-04-08T22:59:59');
    insertEvent(4, '2026-04-08T23:00:00');

    const rows = await repo.listEventsStartedBetween(
      new Date('2026-04-08T18:00:00'),
      new Date('2026-04-08T23:00:00'),
      10,
    );

    expect(rows.map((e) => e.videoPath)).toEqual(['/m/3.mp4', '/m/2.mp4']);
  });
});

describe('DrizzleMediaRepository browse camera names', () => {
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

  it('attaches camera display names to Drizzle browse rows', async () => {
    db.insert(schema.cameras)
      .values({
        id: 'front_door',
        name: 'Front Door',
        type: 'motion',
        config: null,
        enabled: true,
      })
      .run();
    db.insert(motionEvents)
      .values({
        cameraId: 'front_door',
        startedAt: new Date('2026-04-08T12:00:00'),
        endedAt: new Date('2026-04-08T12:00:30'),
        videoPath: '/m/1.mp4',
        snapshotPath: null,
        uploadedToGdrive: false,
        gdriveFileId: null,
        localDeleted: false,
      })
      .run();

    const rows = await repo.listLatestEvents(10);

    expect(rows[0].cameraName).toBe('Front Door');
  });
});

describe('DrizzleMediaRepository canonical camera names', () => {
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

  /** Legacy rows predate the canonical key column, so it starts out null. */
  function insertLegacyCamera(id: string, name: string): void {
    sqlite
      .prepare('INSERT INTO cameras (id, name, type, config, enabled) VALUES (?, ?, ?, NULL, 1)')
      .run(id, name, 'motion');
  }

  function storedNameKeys(): { id: string; name_key: string | null }[] {
    return sqlite.prepare('SELECT id, name_key FROM cameras ORDER BY id').all() as {
      id: string;
      name_key: string | null;
    }[];
  }

  it('finds a legacy camera through the canonical key', async () => {
    insertLegacyCamera('front_door', 'Terrassentür');

    await expect(repo.findCameraByName('  TERRASSENTÜR ')).resolves.toMatchObject({
      id: 'front_door',
    });
    await expect(repo.findCameraByName('terrassentur')).resolves.toBeNull();
  });

  it('backfills every missing name key in one transaction', async () => {
    insertLegacyCamera('front_door', ' Front Door ');
    insertLegacyCamera('garden', 'Terrassentür');

    await repo.backfillNameKeys();

    expect(storedNameKeys()).toEqual([
      { id: 'front_door', name_key: 'front door' },
      { id: 'garden', name_key: cameraNameKey('Terrassentür') },
    ]);
    await expect(repo.findCameraByName('front door')).resolves.toMatchObject({ id: 'front_door' });
  });

  it('is idempotent and leaves already-keyed rows untouched', async () => {
    insertLegacyCamera('front_door', 'Front Door');
    await repo.backfillNameKeys();

    await repo.backfillNameKeys();

    expect(storedNameKeys()).toEqual([{ id: 'front_door', name_key: 'front door' }]);
  });

  it('rejects colliding legacy names without writing any key', async () => {
    insertLegacyCamera('a_front_door', 'Front Door');
    insertLegacyCamera('b_garden', 'Terrassentür');
    insertLegacyCamera('c_front_door', 'FRONT DOOR');

    const failure = await repo.backfillNameKeys().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'CAMERA_NAME_TAKEN' });
    expect((failure as Error).message).not.toMatch(/front|door|terrass/i);
    expect(storedNameKeys()).toEqual([
      { id: 'a_front_door', name_key: null },
      { id: 'b_garden', name_key: null },
      { id: 'c_front_door', name_key: null },
    ]);
  });

  it('rejects a legacy name colliding with an already-keyed camera', async () => {
    insertLegacyCamera('a_front_door', 'Front Door');
    await repo.backfillNameKeys();
    insertLegacyCamera('b_front_door', 'front door');

    await expect(repo.backfillNameKeys()).rejects.toMatchObject({ code: 'CAMERA_NAME_TAKEN' });

    expect(storedNameKeys()).toEqual([
      { id: 'a_front_door', name_key: 'front door' },
      { id: 'b_front_door', name_key: null },
    ]);
  });

  it('refuses a duplicate canonical key at the database level', () => {
    insertLegacyCamera('a_front_door', 'Front Door');
    insertLegacyCamera('b_front_door', 'front door');

    sqlite.prepare('UPDATE cameras SET name_key = ? WHERE id = ?').run('front door', 'a_front_door');

    expect(() =>
      sqlite.prepare('UPDATE cameras SET name_key = ? WHERE id = ?').run('front door', 'b_front_door'),
    ).toThrow(/UNIQUE/);
  });
});
