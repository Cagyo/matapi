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
      { alert: async () => { throw new Error('Telegram unavailable'); } },
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );

    await expect(adapter.alert('remote-object-missing', {
      generationId: 'generation-1',
      artifactId: 'artifact-1',
    })).resolves.toBeUndefined();

    await expect(repository.pending()).resolves.toEqual([
      expect.objectContaining({
        sensorId: null,
        type: 'archive_admin_alert',
        payload: {
          message: '⚠️ An archive object is missing and cannot be restored automatically.',
          kind: 'remote-object-missing',
        },
      }),
    ]);
  });
});
