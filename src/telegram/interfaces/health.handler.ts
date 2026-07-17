import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Composer } from 'grammy';
import { en } from '../../locales/en';
import {
  SENSOR_HEALTH,
  SENSOR_HEALTH_PROBE_TIMEOUT_MS,
  SensorHealthPort,
} from '../../sensors/application/ports/sensor-health.port';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import {
  SYSTEM_HEALTH,
  SystemHealthPort,
} from '../../system/domain/ports/system-health.port';
import { BotRunnerRegistry } from '../../network/application/bot-runner.registry';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

/**
 * `/health` — admin-only system snapshot (spec 08).
 *
 * Composes three ports: OS metrics (`SystemHealthPort`), sensor counts
 * (`SensorQueryPort` + `SensorHealthPort`) and bot polling freshness
 * (`BotRunnerRegistry.getLastUpdateAt`). Each subquery is best-effort;
 * a failure in one does not abort the others.
 */
@Injectable()
export class HealthHandler implements TelegramHandler {
  private readonly logger = new Logger(HealthHandler.name);

  constructor(
    @Inject(SYSTEM_HEALTH) private readonly system: SystemHealthPort,
    @Inject(SENSOR_QUERY) private readonly sensorQuery: SensorQueryPort,
    @Inject(SENSOR_HEALTH) private readonly sensorHealth: SensorHealthPort,
    private readonly botRunner: BotRunnerRegistry,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('health', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'health', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const [snap, enabled] = await Promise.all([
        this.system.collect(),
        this.sensorQuery.listEnabled(),
      ]);
      const probe = await this.sensorHealth.probe(
        enabled.map(({ id }) => id),
        SENSOR_HEALTH_PROBE_TIMEOUT_MS,
      );

      const online = probe.filter(({ status }) => status === 'online').length;
      const lastUpdate = this.botRunner.getLastUpdateAt();
      const lastUpdateAgoSec = lastUpdate
        ? Math.max(0, Math.round((Date.now() - lastUpdate.getTime()) / 1000))
        : null;

      const body = catalog.health.body({
        diskUsedBytes: snap.diskUsedBytes,
        diskTotalBytes: snap.diskTotalBytes,
        cpuTempC: snap.cpuTempC,
        memoryUsedBytes: snap.memoryUsedBytes,
        memoryTotalBytes: snap.memoryTotalBytes,
        uptimeSec: snap.uptimeSec,
        dbSizeBytes: snap.dbSizeBytes,
        botLastUpdateAgoSec: lastUpdateAgoSec,
        sensorsOnline: online,
        sensorsTotal: enabled.length,
      });

      await this.complete(ctx, receipt, () => ctx.reply(`${catalog.health.header}\n\n${body}`));
    } catch (err) {
      this.logger.error(
        `/health failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.complete(ctx, receipt, () => ctx.reply(catalog.health.collectFailed));
    }
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await deliver(); },
        failureNotice: catalog.home.recovery.unavailable,
      });
      return;
    }
    await deliver();
  }
}
