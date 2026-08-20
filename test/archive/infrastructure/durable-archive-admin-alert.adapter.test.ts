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

  it.each([
    'folder-branch-unhealthy',
    'provider-cooldown-prolonged',
    'provider-capacity-blocked',
    'reauthorization-required',
    'backlog-age-prolonged',
    'local-disk-pressure',
  ] as const)('queues a generic %s event without contextual identifiers', async (kind) => {
    const repository = new InMemoryEventRepository();
    const queue = new EventQueueService(repository, { findById: async () => null } as never);
    const adapter = new DurableArchiveAdminAlertAdapter(
      queue,
      { alert: async () => undefined },
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );

    await adapter.alert(kind, {
      generationId: 'private-generation-id',
      artifactId: '/home/pi/motion/2026/08/13/private.mp4',
      errorCode: 'provider-body-secret',
    });

    const [event] = await repository.pending();
    expect(event.payload).toEqual({
      kind,
      message: expect.any(String),
    });
    expect(JSON.stringify(event.payload)).not.toContain('private-generation-id');
    expect(JSON.stringify(event.payload)).not.toContain('/home/pi/motion');
    expect(JSON.stringify(event.payload)).not.toContain('provider-body-secret');
  });
});
