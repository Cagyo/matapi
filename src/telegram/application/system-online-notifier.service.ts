import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventNotifierService } from '../../events/application/event-notifier.service';
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
import { BootRecoveryService } from '../../system/application/boot-recovery.service';

/**
 * Sends the "system online" broadcast on every boot (spec 23 — Boot Recovery
 * step 5). Runs after the notifier is registered; gathers live sensor health
 * and surfaces any database-recovery / clock-drift warning from boot recovery.
 * Additive to `RestartConfirmationService`, which separately reports the cause
 * of a planned restart.
 */
@Injectable()
export class SystemOnlineNotifier {
  private readonly logger = new Logger(SystemOnlineNotifier.name);

  constructor(
    private readonly bootRecovery: BootRecoveryService,
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(SENSOR_HEALTH) private readonly health: SensorHealthPort,
    private readonly notifier: EventNotifierService,
  ) {}

  async run(): Promise<void> {
    const diagnostics = await this.bootRecovery.run();

    const sensors = await this.sensors.listEnabled();
    const probe = await this.health.probe(
      sensors.map(({ id }) => id),
      SENSOR_HEALTH_PROBE_TIMEOUT_MS,
    );
    const sensorsOnline = probe.filter(({ status }) => status === 'online').length;

    if (!this.notifier.isReady()) return;

    const text = en.system.online({
      sensorsOnline,
      sensorsTotal: sensors.length,
      dbRecovery: diagnostics.dbRecovery,
      clockSynchronized: diagnostics.clockSynchronized,
      now: new Date(),
    });

    try {
      await this.notifier.notify({ text, asFile: false });
    } catch (err) {
      this.logger.warn(`Online notice failed: ${(err as Error).message}`);
    }
  }
}
