import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from './ports/drive-credential-repository.port';
import type {
  ArchiveAdminAlert,
  ArchiveAdminAlertDeliveryPort,
  ArchiveAdminAlertKind,
  ArchiveAdminAlertPort,
} from './ports/archive-admin-alert.port';

const COOLDOWN_MS = 60 * 60 * 1_000;
const MAX_CAS_RETRIES = 3;

/**
 * Persists a per-generation cooldown before optional Telegram delivery.
 * Delivery is registered at bot bootstrap so Archive never imports Telegram.
 */
@Injectable()
export class ArchiveAdminAlertService implements ArchiveAdminAlertPort {
  private readonly logger = new Logger(ArchiveAdminAlertService.name);
  private delivery: ArchiveAdminAlertDeliveryPort | null = null;

  constructor(
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly repository: Pick<
      DriveCredentialRepositoryPort,
      'loadActive' | 'readAlertCooldowns' | 'compareAndSetAlertCooldowns'
    >,
    @Inject(CLOCK) private readonly clock: Pick<ClockPort, 'now'>,
  ) {}

  register(delivery: ArchiveAdminAlertDeliveryPort): void {
    this.delivery = delivery;
  }

  clear(): void {
    this.delivery = null;
  }

  async alert(
    kind: ArchiveAdminAlertKind,
    context: Omit<ArchiveAdminAlert, 'kind'>,
  ): Promise<void> {
    const generationId = context.generationId || (await this.repository.loadActive())?.id;
    if (!generationId) return;
    const nowMs = this.clock.now().getTime();
    const persisted = await this.persistCooldown(generationId, kind, nowMs);
    if (!persisted || this.delivery === null) return;

    const alert: ArchiveAdminAlert = { ...context, generationId, kind };
    await this.delivery.send(alert).catch(() => {
      // The cooldown is already durable. Do not leak recipient or provider data in logs.
      this.logger.warn('Archive administrator alert delivery failed');
    });
  }

  private async persistCooldown(
    generationId: string,
    kind: ArchiveAdminAlertKind,
    nowMs: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const current = await this.repository.readAlertCooldowns(generationId);
      if (current === null) return false;
      if ((current[kind] ?? 0) > nowMs) return false;
      const next = { ...current, [kind]: nowMs + COOLDOWN_MS };
      if (await this.repository.compareAndSetAlertCooldowns({
        generationId,
        expected: current,
        next,
      })) return true;
    }
    return false;
  }
}
