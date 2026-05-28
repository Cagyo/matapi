import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, Context } from 'grammy';
import { en } from '../../locales/en';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

@Injectable()
export class StatusHandler implements TelegramHandler {
  private readonly logger = new Logger(StatusHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('status', this.guard.registered, async (ctx) => {
      try {
        const rows = await this.sensors.listEnabled();
        if (rows.length === 0) {
          await ctx.reply(en.status.none);
          return;
        }
        const lines = rows.map((row) =>
          en.status.line(
            row.name,
            row.lastValue ?? '—',
            row.lastValueAt ? row.lastValueAt.toISOString() : 'never',
          ),
        );
        await ctx.reply(`${en.status.header}\n${lines.join('\n')}`);
      } catch (err) {
        this.logger.error(
          `/status failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await ctx.reply(en.common.error('read sensor status', 'internal error'));
      }
    });
  }
}
