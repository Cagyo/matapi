import { describe, expect, it, vi } from 'vitest';
import { ArchiveAdminAlertService } from '../../../src/archive/application/archive-admin-alert.service';
import { DurableArchiveAdminAlertAdapter } from '../../../src/archive/infrastructure/events/durable-archive-admin-alert.adapter';
import { InMemoryDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-credential.repository';
import { EventQueueService } from '../../../src/events/application/event-queue.service';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

describe('DurableArchiveAdminAlertAdapter', () => {
  it('claims one cooldown before one durable enqueue and one immediate delivery', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    await credentials.stage({
      id: 'generation-1', installationId: 'installation-1',
      client: { clientId: 'client', clientSecret: 'secret' }, clientIdHash: 'hash',
      adminUserId: 1, chatId: 1, receiptId: 'receipt', createdAtMs: 1, expiresAtMs: 2,
    });
    const repository = new InMemoryEventRepository();
    const queue = new EventQueueService(repository, { findById: async () => null } as never);
    const enqueue = vi.spyOn(queue, 'enqueueSystemEvent');
    const direct = { send: vi.fn(async () => undefined) };
    const gate = new ArchiveAdminAlertService(
      credentials,
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );
    gate.register(direct);
    const immediate = {
      process: vi.fn(async (event: { id: number }) => {
        await repository.markSent([event.id], new Date('2030-01-01T00:00:00.000Z'));
      }),
    };
    const adapter = new (DurableArchiveAdminAlertAdapter as unknown as new (
      queue: EventQueueService,
      gate: ArchiveAdminAlertService,
      clock: { now(): Date },
      immediate: typeof immediate,
    ) => DurableArchiveAdminAlertAdapter)(
      queue,
      gate,
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
      immediate,
    );

    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });
    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(immediate.process).toHaveBeenCalledOnce();
    expect(direct.send).not.toHaveBeenCalled();
    await expect(repository.pending()).resolves.toEqual([]);
  });

  it('durably queues the admin alert before attempting online delivery', async () => {
    const repository = new InMemoryEventRepository();
    const queue = new EventQueueService(repository, {
      findById: async () => null,
    } as never);
    const adapter = new DurableArchiveAdminAlertAdapter(
      queue,
      { claim: async (kind, context) => ({ ...context, kind }) },
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
      { process: async () => { throw new Error('Telegram unavailable'); } },
    );

    await expect(adapter.alert('remote-object-missing', {
      generationId: 'generation-1',
      artifactId: 'artifact-1',
    })).resolves.toBeUndefined();

    await expect(repository.pending()).resolves.toEqual([
      expect.objectContaining({
        sensorId: null,
        type: 'archive_admin_alert',
        payload: { kind: 'remote-object-missing' },
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
      { claim: async (alertKind) => ({ generationId: 'generation-1', kind: alertKind }) },
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );

    await adapter.alert(kind, {
      generationId: 'private-generation-id',
      artifactId: '/home/pi/motion/2026/08/13/private.mp4',
      errorCode: 'provider-body-secret',
    });

    const [event] = await repository.pending();
    expect(event.payload).toEqual({ kind });
    expect(JSON.stringify(event.payload)).not.toContain('private-generation-id');
    expect(JSON.stringify(event.payload)).not.toContain('/home/pi/motion');
    expect(JSON.stringify(event.payload)).not.toContain('provider-body-secret');
  });

  it('persists only semantic kind and code context', async () => {
    const repository = new InMemoryEventRepository();
    const queue = new EventQueueService(repository, { findById: async () => null } as never);
    const adapter = new DurableArchiveAdminAlertAdapter(
      queue,
      {
        claim: async (kind) => ({
          kind,
          generationId: 'private-generation-id',
          artifactId: 'private-artifact-id',
          errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
        }),
      },
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );

    await adapter.alert('folder-branch-unhealthy', { generationId: 'private-generation-id' });

    const [event] = await repository.pending();
    expect(event.payload).toEqual({
      kind: 'folder-branch-unhealthy',
      errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    });
    expect(JSON.stringify(event.payload)).not.toContain('private-generation-id');
    expect(JSON.stringify(event.payload)).not.toContain('private-artifact-id');
  });
});
