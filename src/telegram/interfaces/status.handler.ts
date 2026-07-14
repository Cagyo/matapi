import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer } from 'grammy';
import { en, StatusRow } from '../../locales/en';
import {
  SENSOR_HEALTH,
  SENSOR_HEALTH_PROBE_TIMEOUT_MS,
  SensorHealthPort,
} from '../../sensors/application/ports/sensor-health.port';
import {
  classifySensorState,
  hasValidUartThresholds,
} from '../../sensors/domain/sensor-state-classifier';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

/**
 * `/status` — spec 07.
 *
 * Renders every enabled sensor with a type icon, formatted value, and a
 * trailing footer. Offline detection delegates to `SensorHealthPort` —
 * the handler never inspects a driver itself.
 */
@Injectable()
export class StatusHandler implements TelegramHandler {
  private readonly logger = new Logger(StatusHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(SENSOR_HEALTH) private readonly health: SensorHealthPort,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('status', this.guard.registered, (ctx) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    try {
      const sensors = await this.sensors.listEnabled();
      if (sensors.length === 0) {
        await ctx.reply(en.status.none);
        return;
      }

      const probe = await this.health.probe(
        sensors.map(({ id }) => id),
        SENSOR_HEALTH_PROBE_TIMEOUT_MS,
      );
      const onlineIds = new Set(
        probe.filter(({ status }) => status === 'online').map(({ sensorId }) => sensorId),
      );
      const rows: StatusRow[] = sensors.map((sensor) => {
        const { level } = classifySensorState(sensor);
        return {
          name: sensor.name,
          type: sensor.type,
          lastValue: sensor.lastValue,
          lastValueAt: sensor.lastValueAt,
          online: onlineIds.has(sensor.id),
          thresholdLevel:
            level === 'warning' || level === 'critical'
              ? level
              : level === 'normal' && hasValidUartThresholds(sensor)
                ? level
                : undefined,
          stepType: typeof sensor.config?.stepType === 'string' ? sensor.config.stepType : undefined,
        };
      });

      const offlineCount = rows.filter((r) => !r.online).length;
      const body = rows.map((r) => en.status.line(r)).join('\n');
      const footer = en.status.footer(offlineCount === 0, offlineCount, new Date());

      await ctx.reply(`${en.status.header}\n\n${body}\n\n${footer}`);
    } catch (err) {
      this.logger.error(
        `/status failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(en.status.readFailed);
    }
  }
}
