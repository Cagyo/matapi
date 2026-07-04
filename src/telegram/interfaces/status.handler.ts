import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en, StatusRow } from '../../locales/en';
import {
  SENSOR_HEALTH,
  SensorHealthPort,
} from '../../sensors/application/ports/sensor-health.port';
import { classifyCo2, Co2Thresholds } from '../../sensors/domain/co2';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../sensors/domain/sensor';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

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

  register(composer: Composer<Context>): void {
    composer.command('status', this.guard.registered, (ctx) =>
      this.handleCommand(ctx),
    );
  }

  async handleCommand(ctx: Context): Promise<void> {
    try {
      const sensors = await this.sensors.listEnabled();
      if (sensors.length === 0) {
        await ctx.reply(en.status.none);
        return;
      }

      const health = await this.health.probe();
      const rows: StatusRow[] = sensors.map((sensor) => ({
        name: sensor.name,
        type: sensor.type,
        lastValue: sensor.lastValue,
        lastValueAt: sensor.lastValueAt,
        online: health.get(sensor.id) ?? false,
        thresholdLevel: thresholdLevelFor(sensor),
        stepType: typeof sensor.config?.stepType === 'string' ? sensor.config.stepType : undefined,
      }));

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

function thresholdLevelFor(sensor: Sensor): StatusRow['thresholdLevel'] {
  if (sensor.type !== 'uart' || sensor.lastValue === null) return undefined;
  const ppm = Number(sensor.lastValue);
  if (!Number.isFinite(ppm)) return undefined;
  const thresholds = extractThresholds(sensor.config);
  if (!thresholds) return undefined;
  return classifyCo2(ppm, thresholds);
}

function extractThresholds(
  raw: Record<string, unknown> | null | undefined,
): Co2Thresholds | null {
  const t = raw?.thresholds as Partial<Co2Thresholds> | undefined;
  if (!t || typeof t.warning !== 'number' || typeof t.critical !== 'number') return null;
  return { warning: t.warning, critical: t.critical };
}
