import { describe, expect, it } from 'vitest';
import { ArchiveAdminAlertService } from '../../../src/archive/application/archive-admin-alert.service';

describe('ArchiveAdminAlertService', () => {
  it('persists cooldown before delivery so a boot loop cannot flood', async () => {
    const now = 1_000;
    const repository = new InMemoryCooldownRepository();
    const delivery = new RecordingDelivery(repository);
    const alerts = new ArchiveAdminAlertService(repository, { now: () => new Date(now) });
    alerts.register(delivery);

    await alerts.alert('reauthorization-required', { generationId: 'g1' });
    await alerts.alert('reauthorization-required', { generationId: 'g1' });

    expect(delivery.sent).toHaveLength(1);
    expect(repository.cooldowns['reauthorization-required']).toBeGreaterThan(now);
    expect(delivery.sawPersistedCooldown).toBe(true);
  });
});

class InMemoryCooldownRepository {
  readonly cooldowns: Record<string, number> = {};

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
  sent: unknown[] = [];
  sawPersistedCooldown = false;

  constructor(private readonly repository: InMemoryCooldownRepository) {}

  async send(alert: unknown): Promise<void> {
    this.sawPersistedCooldown = this.repository.cooldowns['reauthorization-required'] !== undefined;
    this.sent.push(alert);
  }
}
