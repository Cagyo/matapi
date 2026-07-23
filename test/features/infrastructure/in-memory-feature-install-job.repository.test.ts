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
});

function feature(name: 'motion' | 'uart', installed = false, enabled = false): Feature {
  return { name, installed, enabled, config: null, attentionReason: null };
}

function create(
  jobs: InMemoryFeatureInstallJobRepository,
  id: string,
  featureName: 'motion' | 'uart',
  expected = { installed: false, enabled: false },
) {
  return jobs.createQueued({
    id,
    feature: featureName,
    requestedByUserId: 11,
    requestedInChatId: 22,
    workflowReceiptId: `receipt-${id}`,
    expected,
    now,
  });
}

class CompareAndSetFailureFeatureRepository implements FeatureRepositoryPort {
  private readonly delegate: InMemoryFeatureRepository;

  constructor(initial: Feature) {
    this.delegate = new InMemoryFeatureRepository([initial]);
  }

  findByName(name: string) {
    return this.delegate.findByName(name);
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
