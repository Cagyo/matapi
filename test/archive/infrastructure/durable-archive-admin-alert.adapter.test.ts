import { describe, expect, it, vi } from 'vitest';
import { ArchiveAdminAlertService } from '../../../src/archive/application/archive-admin-alert.service';
import { DurableArchiveAdminAlertAdapter } from '../../../src/archive/infrastructure/events/durable-archive-admin-alert.adapter';
import { SharedStateArchiveAdminAlertOutboxAdapter } from '../../../src/archive/infrastructure/events/shared-state-archive-admin-alert-outbox.adapter';
import { InMemoryDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-credential.repository';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const CLOCK = { now: () => NOW };

async function activeFixture() {
  const credentials = new InMemoryDriveCredentialRepository();
  const staged = await credentials.stage({
    id: 'generation-1', installationId: 'installation-1',
    client: { clientId: 'client', clientSecret: 'secret' }, clientIdHash: 'hash',
    adminUserId: 1, chatId: 1, receiptId: 'receipt', createdAtMs: 1, expiresAtMs: 2,
  });
  await credentials.activate({
    stagedId: staged.id, expectedRevision: staged.revision, permissionId: 'owner-1',
    email: null, displayName: null,
    folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' },
    activatedAtMs: 2,
  });
  const repository = new InMemoryEventRepository();
  const gate = new ArchiveAdminAlertService(credentials, CLOCK);
  const outbox = new SharedStateArchiveAdminAlertOutboxAdapter(credentials, repository);
  return { credentials, repository, gate, outbox };
}

describe('DurableArchiveAdminAlertAdapter', () => {
  it('claims one cooldown before one durable enqueue and one immediate delivery', async () => {
    const fixture = await activeFixture();
    const enqueue = vi.spyOn(fixture.repository, 'enqueue');
    const direct = { send: vi.fn(async () => undefined) };
    fixture.gate.register(direct);
    const immediate = {
      process: vi.fn(async (event: { id: number }) => {
        await fixture.repository.markSent([event.id], NOW);
      }),
    };
    const adapter = new DurableArchiveAdminAlertAdapter(
      fixture.outbox, fixture.gate, CLOCK, immediate,
    );

    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });
    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(immediate.process).toHaveBeenCalledOnce();
    expect(direct.send).not.toHaveBeenCalled();
    await expect(fixture.repository.pending()).resolves.toEqual([]);
  });

  it('retries after an enqueue failure without committing a cooldown-only claim', async () => {
    const fixture = await activeFixture();
    vi.spyOn(fixture.repository, 'enqueue')
      .mockRejectedValueOnce(new Error('injected enqueue failure'));
    const immediate = { process: vi.fn(async () => undefined) };
    const adapter = new DurableArchiveAdminAlertAdapter(
      fixture.outbox, fixture.gate, CLOCK, immediate,
    );

    await expect(adapter.alert('provider-capacity-blocked', {
      generationId: 'generation-1',
    })).rejects.toThrow('injected enqueue failure');
    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });
    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });

    await expect(fixture.repository.pending()).resolves.toMatchObject([
      { type: 'archive_admin_alert', payload: { kind: 'provider-capacity-blocked' } },
    ]);
    expect(immediate.process).toHaveBeenCalledOnce();
  });

  it('serializes a concurrent retry behind a failing atomic enqueue', async () => {
    const fixture = await activeFixture();
    let rejectFirst!: (error: Error) => void;
    vi.spyOn(fixture.repository, 'enqueue').mockImplementationOnce(async () =>
      new Promise((_, reject) => { rejectFirst = reject; }));
    const adapter = new DurableArchiveAdminAlertAdapter(fixture.outbox, fixture.gate, CLOCK);

    const first = adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });
    await vi.waitFor(() => expect(fixture.repository.enqueue).toHaveBeenCalledOnce());
    const retry = adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });
    rejectFirst(new Error('injected enqueue failure'));

    await expect(first).rejects.toThrow('injected enqueue failure');
    await expect(retry).resolves.toBeUndefined();
    await expect(fixture.repository.pending()).resolves.toMatchObject([
      { payload: { kind: 'provider-capacity-blocked' } },
    ]);
  });

  it('rejects an alert for an unknown generation', async () => {
    const fixture = await activeFixture();
    const adapter = new DurableArchiveAdminAlertAdapter(fixture.outbox, fixture.gate, CLOCK);

    await adapter.alert('provider-capacity-blocked', { generationId: 'unknown-generation' });

    await expect(fixture.repository.pending()).resolves.toEqual([]);
  });

  it('rejects an unknown generation at the shared outbox boundary', async () => {
    const credentials = new InMemoryDriveCredentialRepository();
    const repository = new InMemoryEventRepository();
    const outbox = new SharedStateArchiveAdminAlertOutboxAdapter(credentials, repository);

    await expect(outbox.enqueue({
      fence: { id: 'unknown-generation', revision: 1, status: 'active' },
      kind: 'provider-capacity-blocked', nowMs: NOW.getTime(),
      cooldownUntilMs: NOW.getTime() + 3_600_000,
    })).resolves.toBeNull();
    await expect(repository.pending()).resolves.toEqual([]);
  });

  it('shares a cooldown with direct archive alert delivery', async () => {
    const fixture = await activeFixture();
    fixture.gate.register({ send: async () => undefined });
    const adapter = new DurableArchiveAdminAlertAdapter(fixture.outbox, fixture.gate, CLOCK);

    await fixture.gate.alert('provider-capacity-blocked', { generationId: 'generation-1' });
    await adapter.alert('provider-capacity-blocked', { generationId: 'generation-1' });

    await expect(fixture.repository.pending()).resolves.toEqual([]);
  });

  it('durably queues the admin alert before attempting online delivery', async () => {
    const fixture = await activeFixture();
    const adapter = new DurableArchiveAdminAlertAdapter(
      fixture.outbox,
      fixture.gate,
      CLOCK,
      { process: async () => { throw new Error('Telegram unavailable'); } },
    );

    await expect(adapter.alert('remote-object-missing', {
      generationId: 'generation-1', artifactId: 'artifact-1',
    })).resolves.toBeUndefined();

    await expect(fixture.repository.pending()).resolves.toEqual([
      expect.objectContaining({
        sensorId: null, type: 'archive_admin_alert',
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
    const fixture = await activeFixture();
    const adapter = new DurableArchiveAdminAlertAdapter(fixture.outbox, fixture.gate, CLOCK);

    await adapter.alert(kind, {
      generationId: 'generation-1',
      artifactId: '/home/pi/motion/2026/08/13/private.mp4',
      errorCode: 'provider-body-secret',
    });

    const [event] = await fixture.repository.pending();
    expect(event.payload).toEqual({ kind });
    expect(JSON.stringify(event.payload)).not.toContain('generation-1');
    expect(JSON.stringify(event.payload)).not.toContain('/home/pi/motion');
    expect(JSON.stringify(event.payload)).not.toContain('provider-body-secret');
  });

  it('persists only semantic kind and code context', async () => {
    const fixture = await activeFixture();
    const adapter = new DurableArchiveAdminAlertAdapter(fixture.outbox, fixture.gate, CLOCK);

    await adapter.alert('folder-branch-unhealthy', {
      generationId: 'generation-1',
      artifactId: 'private-artifact-id',
      errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    });

    const [event] = await fixture.repository.pending();
    expect(event.payload).toEqual({
      kind: 'folder-branch-unhealthy', errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    });
    expect(JSON.stringify(event.payload)).not.toContain('generation-1');
    expect(JSON.stringify(event.payload)).not.toContain('private-artifact-id');
  });
});
