import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import {
  SENSOR_HEALTH,
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
import { GrammyBotGateway } from '../infrastructure/grammy-bot.gateway';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

/**
 * `/health` — admin-only system snapshot (spec 08).
 *
 * Composes three ports: OS metrics (`SystemHealthPort`), sensor counts
 * (`SensorQueryPort` + `SensorHealthPort`) and bot polling freshness
 * (`GrammyBotGateway.getLastUpdateAt`). Each subquery is best-effort;
 * a failure in one does not abort the others.
 */
@Injectable()
export class HealthHandler implements TelegramHandler {
  private readonly logger = new Logger(HealthHandler.name);

  constructor(
    @Inject(SYSTEM_HEALTH) private readonly system: SystemHealthPort,
    @Inject(SENSOR_QUERY) private readonly sensorQuery: SensorQueryPort,
    @Inject(SENSOR_HEALTH) private readonly sensorHealth: SensorHealthPort,
    @Inject(forwardRef(() => GrammyBotGateway))
    private readonly bot: GrammyBotGateway,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('health', this.guard.adminOnly, async (ctx) => {
      try {
        const [snap, enabled, probe] = await Promise.all([
          this.system.collect(),
          this.sensorQuery.listEnabled(),
          this.sensorHealth.probe(),
        ]);

        const online = enabled.filter((s) => probe.get(s.id) === true).length;
        const lastUpdate = this.bot.getLastUpdateAt();
        const lastUpdateAgoSec = lastUpdate
          ? Math.max(0, Math.round((Date.now() - lastUpdate.getTime()) / 1000))
          : null;

        const body = en.health.body({
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

        await ctx.reply(`${en.health.header}\n\n${body}`);
      } catch (err) {
        this.logger.error(
          `/health failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.health.collectFailed);
      }
    });
  }
}
