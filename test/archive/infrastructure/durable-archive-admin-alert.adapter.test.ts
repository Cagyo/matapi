import { describe, expect, it } from 'vitest';
import { DurableArchiveAdminAlertAdapter } from '../../../src/archive/infrastructure/events/durable-archive-admin-alert.adapter';
import { EventQueueService } from '../../../src/events/application/event-queue.service';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

describe('DurableArchiveAdminAlertAdapter', () => {
  it('durably queues the admin alert before attempting online delivery', async () => {
    const repository = new InMemoryEventRepository();
    const queue = new EventQueueService(repository, {
      findById: async () => null,
    } as never);
    const adapter = new DurableArchiveAdminAlertAdapter(
      queue,
      { process: async () => { throw new Error('notifier offline'); } },
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );

    await expect(adapter.alert({
      artifactId: 'artifact-1',
      reason: 'remote_missing_without_local_source',
    })).rejects.toThrow('notifier offline');

    await expect(repository.pending()).resolves.toEqual([
      expect.objectContaining({
        sensorId: null,
        type: 'archive_admin_alert',
        payload: {
          artifactId: 'artifact-1',
          message: '⚠️ Google Drive sync failing: remote_missing_without_local_source',
          reason: 'remote_missing_without_local_source',
        },
      }),
    ]);
  });
});
