import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../../src/database/database.module';
import { features } from '../../../src/database/schema';
import { FeatureInstallBusyError } from '../../../src/features/domain/errors/feature-install-busy.error';
import { FeatureStateChangedError } from '../../../src/features/domain/errors/feature-state-changed.error';
import { DrizzleFeatureInstallJobRepository } from '../../../src/features/infrastructure/drizzle-feature-install-job.repository';

describe('DrizzleFeatureInstallJobRepository', () => {
  const now = new Date('2030-01-02T03:04:05.000Z');
  let sqlite: Database.Database;
  let db: AppDatabase;
  let jobs: DrizzleFeatureInstallJobRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './migrations' });
    jobs = new DrizzleFeatureInstallJobRepository(db);
  });

  afterEach(() => sqlite.close());

  function seed(name: 'digital' | 'uart' | 'motion', installed = false, enabled = false): void {
    db.insert(features).values({ name, installed, enabled, config: null, attentionReason: null }).run();
  }

  function create(
    id: string,
    feature: 'digital' | 'uart' | 'motion',
    expected = { installed: false, enabled: false },
    operation: 'install' | 'reinstall' = 'install',
  ) {
    return jobs.createQueued({
      id,
      feature,
      operation,
      requestedByUserId: 11,
      requestedInChatId: 22,
      workflowReceiptId: `receipt-${id}`,
      expected,
      now,
    });
  }

  async function awaitingRestart(id: string, dispatchIdentity: string) {
    await create(id, 'motion');
    await jobs.markRunning(id, now);
    return jobs.markAwaitingRestart({ id, restartScope: 'worker', dispatchIdentity, now });
  }

  it('creates a queued job only when the expected feature state still matches', async () => {
    seed('motion');
    seed('uart');

    const first = await create('abcdefghijklmnop', 'motion');

    expect(first).toMatchObject({ status: 'queued', activeSlot: 1, createdAt: now, updatedAt: now });
    await expect(create('bcdefghijklmnopa', 'uart')).rejects.toMatchObject({
      code: 'FEATURE_INSTALL_BUSY',
      activeFeature: 'motion',
    } satisfies Partial<FeatureInstallBusyError>);
  });

  it('rejects queued creation when the feature state changed', async () => {
    seed('motion', true, false);

    await expect(create('abcdefghijklmnop', 'motion')).rejects.toEqual(new FeatureStateChangedError('motion'));
  });

  it('marks queued work running and returns active work', async () => {
    seed('motion');
    await create('abcdefghijklmnop', 'motion');

    const running = await jobs.markRunning('abcdefghijklmnop', new Date('2030-01-02T03:05:05.000Z'));

    expect(running).toMatchObject({ status: 'running', activeSlot: 1, updatedAt: new Date('2030-01-02T03:05:05.000Z') });
    expect(await jobs.findActive()).toMatchObject({ id: 'abcdefghijklmnop', status: 'running' });
  });

  it('terminalizes a successful job, enables the feature, and releases the active slot', async () => {
    seed('motion');
    await create('abcdefghijklmnop', 'motion');
    await jobs.markRunning('abcdefghijklmnop', now);

    const completed = await jobs.terminalizeSuccess({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      now: new Date('2030-01-02T03:06:05.000Z'),
    });

    expect(completed).toMatchObject({ status: 'succeeded', activeSlot: null, restartScope: 'worker', failureCode: null });
    expect(await jobs.findActive()).toBeNull();
    expect(db.select().from(features).where(eq(features.name, 'motion')).get()).toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: null,
    });
  });

  it('restores the saved feature flags for a safe failure and records no attention', async () => {
    seed('motion', true, true);
    await create('abcdefghijklmnop', 'motion', { installed: true, enabled: true });
    await jobs.markRunning('abcdefghijklmnop', now);
    db.update(features).set({ installed: false, enabled: false }).run();

    const failed = await jobs.terminalizeFailure({
      id: 'abcdefghijklmnop',
      failureCode: 'request-publish-failed',
      attentionReason: null,
      preservePreviousState: true,
      now: new Date('2030-01-02T03:07:05.000Z'),
    });

    expect(failed).toMatchObject({ status: 'failed', activeSlot: null, failureCode: 'request-publish-failed' });
    expect(db.select().from(features).where(eq(features.name, 'motion')).get()).toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: null,
    });
  });

  it('leaves feature flags intact while recording feature-local attention for an uncertain failure', async () => {
    seed('motion');
    await create('abcdefghijklmnop', 'motion');
    await jobs.markRunning('abcdefghijklmnop', now);
    db.update(features).set({ installed: true, enabled: true }).run();

    await jobs.terminalizeFailure({
      id: 'abcdefghijklmnop',
      failureCode: 'partial-state-uncertain',
      attentionReason: 'partial-state-uncertain',
      preservePreviousState: false,
      now: new Date('2030-01-02T03:08:05.000Z'),
    });

    expect(await jobs.findActive()).toBeNull();
    expect(db.select().from(features).where(eq(features.name, 'motion')).get()).toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: 'partial-state-uncertain',
    });
  });

  it('persists the operation discriminator chosen by the caller', async () => {
    seed('motion', true, true);

    const job = await create('abcdefghijklmnop', 'motion', { installed: true, enabled: true }, 'reinstall');

    expect(job).toMatchObject({ operation: 'reinstall', restartDispatchIdentity: null });
    expect(await jobs.findById('abcdefghijklmnop')).toMatchObject({ operation: 'reinstall' });
  });

  it('defaults a plain install to the install operation', async () => {
    seed('motion');

    expect(await create('abcdefghijklmnop', 'motion')).toMatchObject({ operation: 'install' });
  });

  it('keeps an awaiting-restart job holding the active slot against another feature', async () => {
    seed('motion');
    seed('uart');

    const awaiting = await awaitingRestart('abcdefghijklmnop', 'boot-a:100');

    expect(awaiting).toMatchObject({
      status: 'awaiting-restart',
      activeSlot: 1,
      restartScope: 'worker',
      restartDispatchIdentity: 'boot-a:100',
    });
    expect(await jobs.findActive()).toMatchObject({ id: 'abcdefghijklmnop', status: 'awaiting-restart' });
    await expect(create('bcdefghijklmnopa', 'uart')).rejects.toMatchObject({
      code: 'FEATURE_INSTALL_BUSY',
      activeFeature: 'motion',
    } satisfies Partial<FeatureInstallBusyError>);
  });

  it('keeps an awaiting-restart job out of the recent terminal history', async () => {
    seed('motion');
    await awaitingRestart('abcdefghijklmnop', 'boot-a:100');

    expect(await jobs.listRecentTerminal(5)).toEqual([]);
  });

  it('replaces the dispatch identity only through recordRestartDispatch', async () => {
    seed('motion');
    await awaitingRestart('abcdefghijklmnop', 'boot-a:100');

    const redispatched = await jobs.recordRestartDispatch({
      id: 'abcdefghijklmnop',
      dispatchIdentity: 'boot-b:200',
      now: new Date('2030-01-02T03:09:05.000Z'),
    });

    expect(redispatched).toMatchObject({
      status: 'awaiting-restart',
      activeSlot: 1,
      restartScope: 'worker',
      restartDispatchIdentity: 'boot-b:200',
      updatedAt: new Date('2030-01-02T03:09:05.000Z'),
    });

    const completed = await jobs.terminalizeSuccess({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      now: new Date('2030-01-02T03:10:05.000Z'),
    });

    expect(completed.restartDispatchIdentity).toBe('boot-b:200');
  });

  it('refuses a restart dispatch for a job that is not awaiting a restart', async () => {
    seed('motion');
    await create('abcdefghijklmnop', 'motion');
    await jobs.markRunning('abcdefghijklmnop', now);

    await expect(jobs.recordRestartDispatch({
      id: 'abcdefghijklmnop',
      dispatchIdentity: 'boot-a:100',
      now,
    })).rejects.toThrow("Install job 'abcdefghijklmnop' is not active");
  });

  it('refuses to await a restart from a queued job', async () => {
    seed('motion');
    await create('abcdefghijklmnop', 'motion');

    await expect(jobs.markAwaitingRestart({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      dispatchIdentity: 'boot-a:100',
      now,
    })).rejects.toThrow("Install job 'abcdefghijklmnop' is not active");
  });

  it('releases the active slot when an awaiting-restart job reaches terminal success', async () => {
    seed('motion');
    await awaitingRestart('abcdefghijklmnop', 'boot-a:100');

    const completed = await jobs.terminalizeSuccess({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      now: new Date('2030-01-02T03:11:05.000Z'),
    });

    expect(completed).toMatchObject({ status: 'succeeded', activeSlot: null, failureCode: null });
    expect(await jobs.findActive()).toBeNull();
    expect(db.select().from(features).where(eq(features.name, 'motion')).get()).toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: null,
    });
  });

  it('releases the active slot when an awaiting-restart job reaches terminal failure', async () => {
    seed('motion');
    await awaitingRestart('abcdefghijklmnop', 'boot-a:100');

    const failed = await jobs.terminalizeFailure({
      id: 'abcdefghijklmnop',
      failureCode: 'application-verification-failed',
      attentionReason: 'readiness-failed',
      preservePreviousState: false,
      now: new Date('2030-01-02T03:12:05.000Z'),
    });

    expect(failed).toMatchObject({
      status: 'failed',
      activeSlot: null,
      restartScope: null,
      failureCode: 'application-verification-failed',
      restartDispatchIdentity: 'boot-a:100',
    });
    expect(await jobs.findActive()).toBeNull();
    expect(db.select().from(features).where(eq(features.name, 'motion')).get()).toMatchObject({
      attentionReason: 'readiness-failed',
    });
  });
});
