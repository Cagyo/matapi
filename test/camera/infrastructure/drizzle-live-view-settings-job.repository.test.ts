import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../../src/database/database.module';
import { liveViewSettingsJobs, users } from '../../../src/database/schema';
import { DrizzleLiveViewSettingsJobRepository } from '../../../src/camera/infrastructure/drizzle-live-view-settings-job.repository';
import { LiveViewSettingsStateError } from '../../../src/camera/domain/errors/live-view-settings-state.error';

describe('DrizzleLiveViewSettingsJobRepository', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  let sqlite: Database.Database;
  let db: AppDatabase;
  let jobs: DrizzleLiveViewSettingsJobRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'migrations' });
    db.insert(users).values({ telegramId: 1001, name: 'Admin', role: 'admin' }).run();
    jobs = new DrizzleLiveViewSettingsJobRepository(db);
  });

  afterEach(() => sqlite.close());

  it('follows committed to succeeded and releases the active slot', async () => {
    seedPrepared();

    await jobs.markPublished('AbCdEfGhIjKlMnOp', new Date('2030-01-01T00:01:00.000Z'));
    await jobs.markCommitted('AbCdEfGhIjKlMnOp', new Date('2030-01-01T00:02:00.000Z'));
    const succeeded = await jobs.terminalizeSuccess(
      'AbCdEfGhIjKlMnOp',
      new Date('2030-01-01T00:03:00.000Z'),
    );

    expect(succeeded).toMatchObject({ status: 'succeeded', activeSlot: null, failureCode: null });
    await expect(jobs.findActive()).resolves.toBeNull();
  });

  it('keeps restart-required active with its bounded failure code until success', async () => {
    seedPrepared();
    await jobs.markPublished('AbCdEfGhIjKlMnOp', now);
    await jobs.markCommitted('AbCdEfGhIjKlMnOp', now);

    await expect(jobs.markRestartRequired(
      'AbCdEfGhIjKlMnOp',
      'restart-activation-timeout',
      new Date('2030-01-01T00:04:00.000Z'),
    )).resolves.toMatchObject({
      status: 'restart-required',
      activeSlot: 1,
      failureCode: 'restart-activation-timeout',
    });
    await expect(jobs.terminalizeSuccess(
      'AbCdEfGhIjKlMnOp',
      new Date('2030-01-01T00:05:00.000Z'),
    )).resolves.toMatchObject({ status: 'succeeded', activeSlot: null, failureCode: null });
  });

  it.each(['prepared', 'published'] as const)(
    'compare-and-sets a %s job to failed',
    async (status) => {
      seedPrepared();
      if (status === 'published') await jobs.markPublished('AbCdEfGhIjKlMnOp', now);

      await expect(jobs.terminalizeFailure(
        'AbCdEfGhIjKlMnOp',
        'request-publish-failed',
        new Date('2030-01-01T00:06:00.000Z'),
      )).resolves.toMatchObject({
        status: 'failed',
        activeSlot: null,
        failureCode: 'request-publish-failed',
      });
    },
  );

  it('does not update a job when a transition loses its compare-and-set', async () => {
    seedPrepared();

    await expect(jobs.markCommitted('AbCdEfGhIjKlMnOp', now))
      .rejects.toThrow("Live view settings job 'AbCdEfGhIjKlMnOp' state changed");
    expect(db.select().from(liveViewSettingsJobs)
      .where(eq(liveViewSettingsJobs.id, 'AbCdEfGhIjKlMnOp')).get())
      .toMatchObject({ status: 'prepared', activeSlot: 1 });
  });

  it.each([
    ['malformed request ID', 'short', 3],
    ['fractional generation', 'AbCdEfGhIjKlMnOp', 3.5],
    ['unsafe generation', 'AbCdEfGhIjKlMnOp', 9_007_199_254_740_992n],
  ] as const)('fails closed when a persisted row has a %s', async (_name, id, generation) => {
    sqlite.pragma('ignore_check_constraints = ON');
    sqlite.prepare(`INSERT INTO live_view_settings_jobs
      (id, status, active_slot, expected_generation, candidate_settings,
       requested_by_user_id, requested_in_chat_id, workflow_receipt_id,
       failure_code, created_at, updated_at)
      VALUES (?, 'prepared', 1, ?, ?, 1001, 1001, 'QrStUvWxYz012345', NULL, ?, ?)`)
      .run(
        id,
        generation,
        '{"enabled":true,"allowedCameraCidrs":["192.168.1.0/24"]}',
        now.getTime() / 1_000,
        now.getTime() / 1_000,
      );

    await expect(jobs.findById(id)).rejects.toBeInstanceOf(LiveViewSettingsStateError);
  });

  function seedPrepared(): void {
    db.insert(liveViewSettingsJobs).values({
      id: 'AbCdEfGhIjKlMnOp',
      status: 'prepared',
      activeSlot: 1,
      expectedGeneration: 3,
      candidateSettings: { enabled: true, allowedCameraCidrs: ['192.168.1.0/24'] },
      requestedByUserId: 1001,
      requestedInChatId: 1001,
      workflowReceiptId: 'QrStUvWxYz012345',
      failureCode: null,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
});
