import { describe, expect, it } from 'vitest';
import { ArchiveAdminAlertService } from '../../../src/archive/application/archive-admin-alert.service';
import type { ArchiveAdminAlertKind } from '../../../src/archive/application/ports/archive-admin-alert.port';

describe('ArchiveAdminAlertService', () => {
  it('persists cooldown before delivery so a boot loop cannot flood', async () => {
    const now = 1_000;
    const repository = new InMemoryCooldownRepository();
    const delivery = new RecordingDelivery(repository);
    const alerts = new ArchiveAdminAlertService(repository, { now: () => new Date(now) });
    alerts.register(delivery);

    await alerts.alert('reauthorization-required', { generationId: 'generation-1' });
    await alerts.alert('reauthorization-required', { generationId: 'generation-1' });

    expect(delivery.sent).toHaveLength(1);
    expect(repository.cooldowns['reauthorization-required']).toBeGreaterThan(now);
    expect(delivery.sawPersistedCooldown).toBe(true);
  });

  it.each([
    'folder-branch-unhealthy',
    'provider-cooldown-prolonged',
    'provider-capacity-blocked',
    'reauthorization-required',
    'backlog-age-prolonged',
    'local-disk-pressure',
  ] as const)('deduplicates durable sanitized %s alerts independently', async (kind) => {
    const repository = new InMemoryCooldownRepository();
    const delivery = new RecordingDelivery(repository);
    const alerts = new ArchiveAdminAlertService(repository, { now: () => new Date(1_000) });
    alerts.register(delivery);

    await alerts.alert(kind, {
      generationId: 'generation-1',
      artifactId: 'artifact-1',
      errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    });
    await alerts.alert(kind, {
      generationId: 'generation-1',
      artifactId: 'artifact-1',
      errorCode: '/home/pi/motion/private.mp4?provider-body=secret',
    });

    expect(delivery.sent).toEqual([{
      kind,
      generationId: 'generation-1',
      artifactId: 'artifact-1',
      errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    }]);
    expect(JSON.stringify(delivery.sent)).not.toContain('/home/pi/motion');
    expect(repository.cooldowns[kind]).toBeGreaterThan(1_000);
  });

  it('drops path-shaped and provider-shaped context before online delivery', async () => {
    const repository = new InMemoryCooldownRepository();
    const delivery = new RecordingDelivery(repository);
    const alerts = new ArchiveAdminAlertService(repository, { now: () => new Date(1_000) });
    alerts.register(delivery);

    await alerts.alert('local-disk-pressure', {
      generationId: 'generation-1',
      artifactId: '/home/pi/motion/2026/08/13/private.mp4',
      errorCode: 'provider response: token=secret',
    });

    expect(delivery.sent).toEqual([{
      kind: 'local-disk-pressure',
      generationId: 'generation-1',
    }]);
  });

  it('rejects provider-like hyphenated text as an alert error code', async () => {
    const repository = new InMemoryCooldownRepository();
    const alerts = new ArchiveAdminAlertService(repository, { now: () => new Date(1_000) });

    await expect(alerts.prepare('provider-capacity-blocked', {
      generationId: 'generation-1',
      errorCode: 'provider-body-secret',
    })).resolves.toEqual({
      alert: { kind: 'provider-capacity-blocked', generationId: 'generation-1' },
      fence: { id: 'generation-1', revision: 4, status: 'active' },
    });
  });
});

class InMemoryCooldownRepository {
  readonly cooldowns: Record<string, number> = {};

  async loadActive() {
    return { id: 'generation-1', revision: 4, status: 'active' } as never;
  }

  async readAlertCooldowns(): Promise<Record<string, number>> {
    return { ...this.cooldowns };
  }

  async compareAndSetAlertCooldowns(input: { expected: Record<string, number>; next: Record<string, number> }): Promise<boolean> {
    if (JSON.stringify(input.expected) !== JSON.stringify(this.cooldowns)) return false;
    Object.assign(this.cooldowns, input.next);
    return true;
  }
}

class RecordingDelivery {
  sent: { kind: ArchiveAdminAlertKind; generationId: string; artifactId?: string; errorCode?: string }[] = [];
  sawPersistedCooldown = false;

  constructor(private readonly repository: InMemoryCooldownRepository) {}

  async send(alert: { kind: ArchiveAdminAlertKind; generationId: string; artifactId?: string; errorCode?: string }): Promise<void> {
    this.sawPersistedCooldown = this.repository.cooldowns['reauthorization-required'] !== undefined;
    this.sent.push(alert);
  }
}
