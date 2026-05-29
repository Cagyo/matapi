import { Module } from '@nestjs/common';
import { CLOCK } from '../events/domain/ports/clock.port';
import { SystemClockAdapter } from '../events/infrastructure/system-clock.adapter';
import { BotRunnerRegistry } from './application/bot-runner.registry';
import { CheckBotPollingService } from './application/check-bot-polling.service';
import { HeartbeatSchedulerService } from './application/heartbeat-scheduler.service';
import { WatchdogService } from './application/watchdog.service';
import { HEARTBEAT_CLIENT } from './domain/ports/heartbeat-client.port';
import { WATCHDOG } from './domain/ports/watchdog.port';
import { FetchHeartbeatAdapter } from './infrastructure/fetch-heartbeat.adapter';
import { FileWatchdogAdapter } from './infrastructure/file-watchdog.adapter';
import { StubWatchdogAdapter } from './infrastructure/stub-watchdog.adapter';
import { WATCHDOG_ENABLED } from './network.tokens';

const watchdogEnabled = process.env.HARDWARE_WATCHDOG_ENABLED === 'true';

/**
 * Network context composition root (spec 22): external heartbeat, bot-polling
 * watchdog, and the optional Pi hardware watchdog.
 *
 * `BotRunnerRegistry` is exported as a register/clear seam — the telegram
 * `GrammyBotGateway` registers itself at bootstrap so this context can recover
 * the runner without importing the telegram module (no cycle). The hardware
 * watchdog adapter is selected by `HARDWARE_WATCHDOG_ENABLED`; everywhere else
 * the stub is bound so the pet loop stays inert.
 */
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClockAdapter },
    { provide: HEARTBEAT_CLIENT, useClass: FetchHeartbeatAdapter },
    { provide: WATCHDOG_ENABLED, useValue: watchdogEnabled },
    {
      provide: WATCHDOG,
      useClass: watchdogEnabled ? FileWatchdogAdapter : StubWatchdogAdapter,
    },
    BotRunnerRegistry,
    HeartbeatSchedulerService,
    CheckBotPollingService,
    WatchdogService,
  ],
  exports: [BotRunnerRegistry],
})
export class NetworkModule {}
