import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admissionQueueQuery,
  attemptDeadlineQuery,
  blockedPrefixQuery,
  queueStatusAggregateQuery,
  type ArchiveSqlQuery,
} from '../../../src/archive/infrastructure/persistence/archive-queue.queries';
import * as schema from '../../../src/database/schema';

const GENERATION_ID = 'generation-1';
const NOW_MS = 1_000;

describe('archive queue query plans', () => {
  const sqlite = new Database(':memory:');

  beforeAll(() => {
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });
    seedArchivePressureFixture(sqlite, {
      queued: 10_000,
      historicalAttempts: 50_000,
    });
    sqlite.exec('ANALYZE');
  });

  afterAll(() => sqlite.close());

  it('uses each production query\'s own queue-critical indexes at 10000/50000 pressure', () => {
    expectPlanUses(sqlite, admissionQueueQuery({
      generationId: GENERATION_ID,
      nowMs: NOW_MS,
      limit: 1,
    }), [
      'idx_archive_artifacts_admission_queue',
      'idx_drive_attempts_artifact_generation_state',
      'idx_drive_motion_folder_current_health',
    ]);
    expectPlanUses(sqlite, attemptDeadlineQuery({
      generationId: GENERATION_ID,
      nowMs: NOW_MS,
    }), [
      'idx_drive_attempts_generation_queue',
    ]);
    expectPlanUses(sqlite, queueStatusAggregateQuery(GENERATION_ID, NOW_MS), [
      'idx_archive_artifacts_admission_queue',
      'idx_drive_attempts_generation_queue',
      'idx_drive_attempts_artifact_generation_state',
      'idx_drive_motion_folder_current_health',
    ]);
    expectPlanUses(sqlite, blockedPrefixQuery({
      generationId: GENERATION_ID,
      dayPath: '2026/08/13',
    }), [
      'idx_drive_motion_folder_current_health',
    ]);
  });

  it('embeds the shared blocked-prefix SQL in both bounded production queue paths', () => {
    const blockedPrefix = blockedPrefixQuery({
      generationId: GENERATION_ID,
      dayPath: schema.archiveArtifacts.motionDayPath,
    });
    const admission = admissionQueueQuery({
      generationId: GENERATION_ID,
      nowMs: NOW_MS,
      limit: 1,
    });
    const status = queueStatusAggregateQuery(GENERATION_ID, NOW_MS);

    expect(admission.sql).toContain(blockedPrefix.sql);
    expect(status.sql).toContain(blockedPrefix.sql);
  });

  it('returns aggregate status as one bounded SQL row with distinct retryable artifacts', () => {
    const query = queueStatusAggregateQuery(GENERATION_ID, NOW_MS);
    const rows = sqlite.prepare(query.sql).all(...query.params) as QueueAggregateRow[];

    expect(query.sql.toLowerCase()).toMatch(/count\s*\(\s*distinct\s+artifact_id\s*\)/u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queuedVideos: 10_000,
      retryableVideos: 3_000,
      oldestQueuedVideoAtMs: 1,
      branchBlocked: 0,
    });
  });

  it('keeps every external query value in prepared-statement parameters', () => {
    const markerGeneration = 'generation-bound-marker';
    const markerDayPath = '2099/12/31';
    const markerNowMs = 987_654;
    const markerLimit = 17;
    const cases = [
      {
        query: admissionQueueQuery({
          generationId: markerGeneration,
          nowMs: markerNowMs,
          limit: markerLimit,
        }),
        values: [markerGeneration, markerNowMs, markerLimit],
      },
      {
        query: attemptDeadlineQuery({
          generationId: markerGeneration,
          nowMs: markerNowMs,
        }),
        values: [markerGeneration, markerNowMs],
      },
      {
        query: queueStatusAggregateQuery(markerGeneration, markerNowMs),
        values: [markerGeneration, markerNowMs],
      },
      {
        query: blockedPrefixQuery({
          generationId: markerGeneration,
          dayPath: markerDayPath,
        }),
        values: [markerGeneration, markerDayPath],
      },
    ];

    for (const { query, values } of cases) {
      expect(query.sql).not.toContain(markerGeneration);
      expect(query.sql).not.toContain(markerDayPath);
      expect(query.sql).not.toContain(String(markerNowMs));
      for (const value of values) expect(query.params).toContain(value);
    }
  });
});

function explain(sqlite: Database.Database, query: ArchiveSqlQuery): string[] {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as QueryPlanRow[])
    .map(({ detail }) => detail);
}

function expectPlanUses(
  sqlite: Database.Database,
  query: ArchiveSqlQuery,
  indexes: readonly string[],
): void {
  const plan = explain(sqlite, query).join('\n');
  for (const index of indexes) expect(plan).toContain(index);
  expect(plan).not.toMatch(/SCAN drive_object_attempts(?:\s|$)/u);
}

function seedArchivePressureFixture(
  sqlite: Database.Database,
  input: { queued: number; historicalAttempts: number },
): void {
  const insertArtifact = sqlite.prepare(`
    INSERT INTO archive_artifacts (
      id, installation_id, kind, source_identity, trusted_path, relative_path,
      size, mtime_ns, source_time_ms, sha256, source_fingerprint, state,
      admission_state, motion_day_path, admission_next_at, admission_revision,
      created_at, updated_at, revision
    ) VALUES (?, ?, 'motion_video', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, 0)
  `);
  const insertAttempt = sqlite.prepare(`
    INSERT INTO drive_object_attempts (
      id, artifact_id, generation_id, remote_file_id, parent_id, reserved_at,
      state, revision, next_attempt_at, retry_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'parent-1', ?, ?, 0, ?, ?, ?, ?)
  `);
  const seed = sqlite.transaction(() => {
    for (let index = 0; index < input.queued; index += 1) {
      const ordinal = index + 1;
      const id = `artifact-${ordinal.toString().padStart(5, '0')}`;
      const dayPath = index % 2 === 0 ? '2026/08/13' : '2026/08/14';
      insertArtifact.run(
        id,
        'installation-1',
        `source-${ordinal}`,
        `/fixture/${ordinal}`,
        `2026/08/${dayPath.slice(-2)}/${ordinal}.mp4`,
        1_024 + ordinal,
        String(ordinal),
        ordinal,
        `sha256-${ordinal}`,
        `fingerprint-${ordinal}`,
        index < 2_000 ? 'retryable' : 'ready',
        dayPath,
        0,
        ordinal,
        ordinal,
      );
    }

    for (let index = 0; index < input.historicalAttempts; index += 1) {
      const artifactIndex = Math.floor(index / 10);
      const ordinal = index + 1;
      const artifactId = `artifact-${(artifactIndex + 1).toString().padStart(5, '0')}`;
      const retryable = index % 10 === 0 && artifactIndex >= 1_500 && artifactIndex < 3_000;
      insertAttempt.run(
        `attempt-${ordinal.toString().padStart(5, '0')}`,
        artifactId,
        GENERATION_ID,
        `remote-${ordinal}`,
        ordinal,
        retryable ? 'retryable' : 'deleted',
        retryable ? 0 : ordinal,
        retryable ? 1 : 0,
        ordinal,
        ordinal,
      );
    }

    sqlite.prepare(`
      INSERT INTO drive_motion_folder_reservations (
        id, installation_id, generation_id, normalized_path, level, segment_name,
        folder_id, parent_folder_id, state, current_slot, revision,
        revalidation_failure_streak, next_revalidation_at, created_at, updated_at
      ) VALUES (
        'folder-reservation-1', 'installation-1', ?, '2026/08/13', 'day', '13',
        'folder-1', 'month-1', 'detached', 1, 0, 1, 2_000, 1, 1
      )
    `).run(GENERATION_ID);
  });

  seed();
}

interface QueryPlanRow {
  detail: string;
}

interface QueueAggregateRow {
  queuedVideos: number;
  retryableVideos: number;
  oldestQueuedVideoAtMs: number | null;
  branchBlocked: number;
}
