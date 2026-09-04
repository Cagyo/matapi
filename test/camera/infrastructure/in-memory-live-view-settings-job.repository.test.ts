import { describe, expect, it } from 'vitest';
import { LiveViewSettingsBusyError } from '../../../src/camera/domain/errors/live-view-settings-busy.error';
import { InMemoryLiveViewSettingsJobRepository } from '../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository';

const prepared = {
  id: 'AbCdEfGhIjKlMnOp',
  expectedGeneration: 3,
  candidateSettings: { enabled: true, allowedCameraCidrs: ['192.168.1.0/24'] },
  requestedByUserId: 1001,
  requestedInChatId: 1001,
  workflowReceiptId: 'QrStUvWxYz012345',
  now: new Date('2030-01-01T00:00:00.000Z'),
} as const;

describe('InMemoryLiveViewSettingsJobRepository', () => {
  it('keeps one active job through committed restart recovery and then releases it', async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    jobs.claimPrepared(prepared);

    await expect(jobs.markPublished(prepared.id, new Date('2030-01-01T00:01:00.000Z')))
      .resolves.toMatchObject({ status: 'published', activeSlot: 1 });
    await expect(jobs.markCommitted(prepared.id, new Date('2030-01-01T00:02:00.000Z')))
      .resolves.toMatchObject({ status: 'committed', activeSlot: 1 });
    await expect(jobs.markRestartRequired(
      prepared.id,
      'restart-dispatch-failed',
      new Date('2030-01-01T00:03:00.000Z'),
    )).resolves.toMatchObject({
      status: 'restart-required',
      activeSlot: 1,
      failureCode: 'restart-dispatch-failed',
    });

    expect(() => jobs.claimPrepared({ ...prepared, id: 'BcDeFgHiJkLmNoPq' }))
      .toThrow(LiveViewSettingsBusyError);
    await expect(jobs.terminalizeSuccess(prepared.id, new Date('2030-01-01T00:04:00.000Z')))
      .resolves.toMatchObject({ status: 'succeeded', activeSlot: null, failureCode: null });
    await expect(jobs.findActive()).resolves.toBeNull();
  });

  it('supports committed to succeeded without requiring a restart', async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    jobs.claimPrepared(prepared);
    await jobs.markPublished(prepared.id, prepared.now);
    await jobs.markCommitted(prepared.id, prepared.now);

    await expect(jobs.terminalizeSuccess(prepared.id, prepared.now))
      .resolves.toMatchObject({ status: 'succeeded', activeSlot: null });
  });

  it.each(['prepared', 'published'] as const)(
    'compare-and-sets a %s job to failed',
    async (status) => {
      const jobs = new InMemoryLiveViewSettingsJobRepository();
      jobs.claimPrepared(prepared);
      if (status === 'published') await jobs.markPublished(prepared.id, prepared.now);

      await expect(jobs.terminalizeFailure(
        prepared.id,
        'request-publish-failed',
        new Date('2030-01-01T00:05:00.000Z'),
      )).resolves.toMatchObject({
        status: 'failed',
        activeSlot: null,
        failureCode: 'request-publish-failed',
      });
    },
  );

  it('returns only the latest terminal job by updated then created time', async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    jobs.claimPrepared(prepared);
    await jobs.markPublished(prepared.id, prepared.now);
    await jobs.markCommitted(prepared.id, prepared.now);
    await jobs.terminalizeSuccess(
      prepared.id,
      new Date('2030-01-01T00:04:00.000Z'),
    );

    jobs.claimPrepared({
      ...prepared,
      id: 'BcDeFgHiJkLmNoPq',
      now: new Date('2030-01-01T00:01:00.000Z'),
    });
    await jobs.terminalizeFailure(
      'BcDeFgHiJkLmNoPq',
      'interrupted',
      new Date('2030-01-01T00:03:00.000Z'),
    );
    await expect(jobs.findLatestTerminal()).resolves.toMatchObject({
      id: prepared.id,
      status: 'succeeded',
    });

    jobs.claimPrepared({
      ...prepared,
      id: 'CdEfGhIjKlMnOpQr',
      now: new Date('2030-01-01T00:02:00.000Z'),
    });
    await jobs.terminalizeFailure(
      'CdEfGhIjKlMnOpQr',
      'interrupted',
      new Date('2030-01-01T00:04:00.000Z'),
    );
    await expect(jobs.findLatestTerminal()).resolves.toMatchObject({
      id: 'CdEfGhIjKlMnOpQr',
      status: 'failed',
    });
  });

  it('rejects an invalid compare-and-set without changing the job', async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    jobs.claimPrepared(prepared);

    await expect(jobs.markCommitted(prepared.id, prepared.now))
      .rejects.toThrow("Live view settings job 'AbCdEfGhIjKlMnOp' state changed");
    await expect(jobs.findById(prepared.id)).resolves.toMatchObject({
      status: 'prepared',
      activeSlot: 1,
    });
  });
});
