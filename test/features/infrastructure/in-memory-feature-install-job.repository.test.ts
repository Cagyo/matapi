import { describe, expect, it } from 'vitest';
import { Feature } from '../../../src/features/domain/feature.entity';
import type { FeatureRepositoryPort } from '../../../src/features/domain/ports/feature-repository.port';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

const now = new Date('2030-01-02T03:04:05.000Z');

describe('InMemoryFeatureInstallJobRepository', () => {
  it('allows only one concurrent queued job globally', async () => {
    const features = new InMemoryFeatureRepository([feature('motion'), feature('uart')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);

    const results = await Promise.allSettled([
      create(jobs, 'abcdefghijklmnop', 'motion'),
      create(jobs, 'bcdefghijklmnopa', 'uart'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await jobs.findActive()).toMatchObject({ status: 'queued', activeSlot: 1 });
  });

  it('rejects marking an already running job as running without updating it', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    const queued = await create(jobs, 'abcdefghijklmnop', 'motion');
    const runningAt = new Date('2030-01-02T03:05:05.000Z');
    const repeatedAt = new Date('2030-01-02T03:06:05.000Z');

    await jobs.markRunning(queued.id, runningAt);

    await expect(jobs.markRunning(queued.id, repeatedAt)).rejects.toThrow("Install job 'abcdefghijklmnop' is not active");
    await expect(jobs.findById(queued.id)).resolves.toMatchObject({
      status: 'running',
      activeSlot: 1,
      updatedAt: runningAt,
    });
  });

  it('owns queued timestamps independently of caller and returned jobs', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    const createdAt = new Date('2030-01-02T03:04:05.000Z');
    const queued = await jobs.createQueued({
      id: 'abcdefghijklmnop',
      feature: 'motion',
      operation: 'install',
      requestedByUserId: 11,
      requestedInChatId: 22,
      workflowReceiptId: 'receipt-abcdefghijklmnop',
      expected: { installed: false, enabled: false },
      now: createdAt,
    });

    expect(queued.createdAt).not.toBe(queued.updatedAt);

    createdAt.setTime(new Date('2040-01-01T00:00:00.000Z').getTime());
    queued.createdAt.setTime(new Date('2041-01-01T00:00:00.000Z').getTime());
    queued.updatedAt.setTime(new Date('2042-01-01T00:00:00.000Z').getTime());

    const found = await jobs.findById(queued.id);
    expect(found).toMatchObject({
      createdAt: new Date('2030-01-02T03:04:05.000Z'),
      updatedAt: new Date('2030-01-02T03:04:05.000Z'),
    });

    found?.createdAt.setTime(new Date('2043-01-01T00:00:00.000Z').getTime());
    found?.updatedAt.setTime(new Date('2044-01-01T00:00:00.000Z').getTime());

    const active = await jobs.findActive();
    expect(active).toMatchObject({
      createdAt: new Date('2030-01-02T03:04:05.000Z'),
      updatedAt: new Date('2030-01-02T03:04:05.000Z'),
    });
  });

  it('owns transition timestamps and terminal-job results independently', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    const queued = await create(jobs, 'abcdefghijklmnop', 'motion');
    const runningAt = new Date('2030-01-02T03:05:05.000Z');
    const running = await jobs.markRunning(queued.id, runningAt);

    runningAt.setTime(new Date('2040-01-01T00:00:00.000Z').getTime());
    running.updatedAt.setTime(new Date('2041-01-01T00:00:00.000Z').getTime());

    await expect(jobs.findById(queued.id)).resolves.toMatchObject({
      updatedAt: new Date('2030-01-02T03:05:05.000Z'),
    });

    const completedAt = new Date('2030-01-02T03:06:05.000Z');
    const completed = await jobs.terminalizeSuccess({ id: queued.id, restartScope: 'worker', now: completedAt });

    completedAt.setTime(new Date('2042-01-01T00:00:00.000Z').getTime());
    completed.createdAt.setTime(new Date('2043-01-01T00:00:00.000Z').getTime());
    completed.updatedAt.setTime(new Date('2044-01-01T00:00:00.000Z').getTime());

    const [recent] = await jobs.listRecentTerminal(1);
    expect(recent).toMatchObject({
      createdAt: now,
      updatedAt: new Date('2030-01-02T03:06:05.000Z'),
    });

    recent.updatedAt.setTime(new Date('2045-01-01T00:00:00.000Z').getTime());
    await expect(jobs.findById(queued.id)).resolves.toMatchObject({
      createdAt: now,
      updatedAt: new Date('2030-01-02T03:06:05.000Z'),
    });
  });

  it('keeps a running job active and restores the feature when success cannot enable it', async () => {
    const features = new CompareAndSetFailureFeatureRepository(feature('motion'));
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    const queued = await create(jobs, 'abcdefghijklmnop', 'motion');
    await expect(jobs.findById(queued.id)).resolves.toMatchObject({ status: 'queued', activeSlot: 1 });
    await jobs.markRunning(queued.id, now);

    await expect(jobs.terminalizeSuccess({ id: queued.id, restartScope: 'worker', now }))
      .rejects.toThrow("Feature 'motion' state changed before terminalization");

    await expect(jobs.findById(queued.id)).resolves.toMatchObject({
      status: 'running',
      activeSlot: 1,
    });
    await expect(features.findByName('motion')).resolves.toMatchObject({
      installed: false,
      enabled: false,
      attentionReason: null,
    });
  });

  it('keeps a running job active and restores the feature when safe failure cannot restore its enabled flag', async () => {
    const features = new CompareAndSetFailureFeatureRepository(feature('motion', true, true));
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    const queued = await create(jobs, 'abcdefghijklmnop', 'motion', { installed: true, enabled: true });
    await expect(jobs.findById(queued.id)).resolves.toMatchObject({ status: 'queued', activeSlot: 1 });
    await jobs.markRunning(queued.id, now);
    await features.setEnabled('motion', false);
    await features.setVerified({ name: 'motion', installed: false, attentionReason: null });

    await expect(jobs.terminalizeFailure({
      id: queued.id,
      failureCode: 'request-publish-failed',
      attentionReason: 'install-failed',
      preservePreviousState: true,
      now,
    })).rejects.toThrow("Feature 'motion' state changed before terminalization");

    await expect(jobs.findById(queued.id)).resolves.toMatchObject({
      status: 'running',
      activeSlot: 1,
    });
    await expect(features.findByName('motion')).resolves.toMatchObject({
      installed: false,
      enabled: false,
      attentionReason: null,
    });
  });

  it('persists the operation discriminator chosen by the caller', async () => {
    const features = new InMemoryFeatureRepository([feature('motion', true, true)]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);

    const job = await create(jobs, 'abcdefghijklmnop', 'motion', { installed: true, enabled: true }, 'reinstall');

    expect(job).toMatchObject({ operation: 'reinstall', restartDispatchIdentity: null });
    await expect(jobs.findById(job.id)).resolves.toMatchObject({ operation: 'reinstall' });
  });

  it('defaults a plain install to the install operation', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);

    await expect(create(jobs, 'abcdefghijklmnop', 'motion')).resolves.toMatchObject({ operation: 'install' });
  });

  it('keeps an awaiting-restart job holding the active slot against another feature', async () => {
    const features = new InMemoryFeatureRepository([feature('motion'), feature('uart')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);

    const awaiting = await awaitingRestart(jobs, 'abcdefghijklmnop', 'boot-a:100');

    expect(awaiting).toMatchObject({
      status: 'awaiting-restart',
      activeSlot: 1,
      restartScope: 'worker',
      restartDispatchIdentity: 'boot-a:100',
    });
    await expect(jobs.findActive()).resolves.toMatchObject({ id: 'abcdefghijklmnop', status: 'awaiting-restart' });
    await expect(create(jobs, 'bcdefghijklmnopa', 'uart')).rejects.toMatchObject({ code: 'FEATURE_INSTALL_BUSY' });
  });

  it('keeps an awaiting-restart job out of the recent terminal history', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);

    await awaitingRestart(jobs, 'abcdefghijklmnop', 'boot-a:100');

    await expect(jobs.listRecentTerminal(5)).resolves.toEqual([]);
  });

  it('replaces the dispatch identity only through recordRestartDispatch', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    await awaitingRestart(jobs, 'abcdefghijklmnop', 'boot-a:100');
    const dispatchedAt = new Date('2030-01-02T03:09:05.000Z');

    const redispatched = await jobs.recordRestartDispatch({
      id: 'abcdefghijklmnop',
      dispatchIdentity: 'boot-b:200',
      now: dispatchedAt,
    });

    expect(redispatched).toMatchObject({
      status: 'awaiting-restart',
      activeSlot: 1,
      restartScope: 'worker',
      restartDispatchIdentity: 'boot-b:200',
      updatedAt: dispatchedAt,
    });

    const completed = await jobs.terminalizeSuccess({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      now: new Date('2030-01-02T03:10:05.000Z'),
    });

    expect(completed.restartDispatchIdentity).toBe('boot-b:200');
  });

  it('refuses a restart dispatch for a job that is not awaiting a restart', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    await create(jobs, 'abcdefghijklmnop', 'motion');
    await jobs.markRunning('abcdefghijklmnop', now);

    await expect(jobs.recordRestartDispatch({
      id: 'abcdefghijklmnop',
      dispatchIdentity: 'boot-a:100',
      now,
    })).rejects.toThrow("Install job 'abcdefghijklmnop' is not active");
  });

  it('refuses to await a restart from a queued job', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    await create(jobs, 'abcdefghijklmnop', 'motion');

    await expect(jobs.markAwaitingRestart({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      dispatchIdentity: 'boot-a:100',
      now,
    })).rejects.toThrow("Install job 'abcdefghijklmnop' is not active");
  });

  it('releases the active slot when an awaiting-restart job reaches terminal success', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    await awaitingRestart(jobs, 'abcdefghijklmnop', 'boot-a:100');

    const completed = await jobs.terminalizeSuccess({
      id: 'abcdefghijklmnop',
      restartScope: 'worker',
      now: new Date('2030-01-02T03:11:05.000Z'),
    });

    expect(completed).toMatchObject({ status: 'succeeded', activeSlot: null, failureCode: null });
    await expect(jobs.findActive()).resolves.toBeNull();
    await expect(features.findByName('motion')).resolves.toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: null,
    });
  });

  it('releases the active slot when an awaiting-restart job reaches terminal failure', async () => {
    const features = new InMemoryFeatureRepository([feature('motion')]);
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    await awaitingRestart(jobs, 'abcdefghijklmnop', 'boot-a:100');

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
    await expect(jobs.findActive()).resolves.toBeNull();
    await expect(features.findByName('motion')).resolves.toMatchObject({ attentionReason: 'readiness-failed' });
  });
});

function feature(name: 'motion' | 'uart', installed = false, enabled = false): Feature {
  return { name, installed, enabled, config: null, attentionReason: null };
}

function create(
  jobs: InMemoryFeatureInstallJobRepository,
  id: string,
  featureName: 'motion' | 'uart',
  expected = { installed: false, enabled: false },
  operation: 'install' | 'reinstall' = 'install',
) {
  return jobs.createQueued({
    id,
    feature: featureName,
    operation,
    requestedByUserId: 11,
    requestedInChatId: 22,
    workflowReceiptId: `receipt-${id}`,
    expected,
    now,
  });
}

async function awaitingRestart(
  jobs: InMemoryFeatureInstallJobRepository,
  id: string,
  dispatchIdentity: string,
) {
  await create(jobs, id, 'motion');
  await jobs.markRunning(id, now);
  return jobs.markAwaitingRestart({ id, restartScope: 'worker', dispatchIdentity, now });
}

class CompareAndSetFailureFeatureRepository implements FeatureRepositoryPort {
  private readonly delegate: InMemoryFeatureRepository;

  constructor(initial: Feature) {
    this.delegate = new InMemoryFeatureRepository([initial]);
  }

  findByName(name: string) {
    return this.delegate.findByName(name);
  }

  insertMissing(rows: Parameters<FeatureRepositoryPort['insertMissing']>[0]) {
    return this.delegate.insertMissing(rows);
  }

  setEnabled(name: string, enabled: boolean) {
    return this.delegate.setEnabled(name, enabled);
  }

  compareAndSetEnabled(): ReturnType<FeatureRepositoryPort['compareAndSetEnabled']> {
    return Promise.resolve(null);
  }

  setVerified(input: Parameters<FeatureRepositoryPort['setVerified']>[0]) {
    return this.delegate.setVerified(input);
  }

  setAttention(name: Parameters<FeatureRepositoryPort['setAttention']>[0], reason: Parameters<FeatureRepositoryPort['setAttention']>[1]) {
    return this.delegate.setAttention(name, reason);
  }
}
