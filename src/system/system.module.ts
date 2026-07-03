import { Module } from '@nestjs/common';
import { EventModule } from '../events/event.module';
import { BootRecoveryService } from './application/boot-recovery.service';
import { GracefulShutdownService } from './application/graceful-shutdown.service';
import { CLOCK_SYNC_PROBE } from './domain/ports/clock-sync.port';
import { OTA } from './domain/ports/ota.port';
import { PROCESS_RESTARTER } from './domain/ports/process-restarter.port';
import { SYSTEM_DEPS } from './domain/ports/system-deps.port';
import { SYSTEM_META_REPOSITORY } from './domain/ports/system-meta-repository.port';
import { SYSTEM_HEALTH } from './domain/ports/system-health.port';
import { DrizzleSystemMetaRepository } from './infrastructure/drizzle-system-meta.repository';
import { OsSystemHealthAdapter } from './infrastructure/os-system-health.adapter';
import { Pm2ProcessRestarter } from './infrastructure/pm2-process-restarter.adapter';
import { ShellOtaAdapter } from './infrastructure/shell-ota.adapter';
import { ShellSystemDepsAdapter } from './infrastructure/shell-system-deps.adapter';
import { TimedatectlClockSyncAdapter } from './infrastructure/timedatectl-clock-sync.adapter';
import { StubOtaAdapter } from './infrastructure/stub-ota.adapter';
import { StubProcessRestarter } from './infrastructure/stub-process-restarter.adapter';
import { StubSystemDepsAdapter } from './infrastructure/stub-system-deps.adapter';

export type SystemMode = 'real' | 'stub';

export function resolveSystemMode(): SystemMode {
  if (process.env.SYSTEM_MODE === 'stub') return 'stub';
  if (process.env.SYSTEM_MODE === 'real') return 'real';
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') return 'stub';
  return process.platform === 'linux' ? 'real' : 'stub';
}

const mode = resolveSystemMode();

/**
 * Cross-cutting `system/` context — exposes OS-level metrics, OTA control,
 * process-restart capability, and boot/shutdown coordination (spec 23) to
 * other contexts via ports. Imports `EventModule` so the shutdown coordinator
 * can drain the event pipeline and broadcast the offline notice.
 */
@Module({
  imports: [EventModule],
  providers: [
    BootRecoveryService,
    GracefulShutdownService,
    { provide: SYSTEM_HEALTH, useClass: OsSystemHealthAdapter },
    { provide: SYSTEM_META_REPOSITORY, useClass: DrizzleSystemMetaRepository },
    {
      provide: PROCESS_RESTARTER,
      useClass: mode === 'stub' ? StubProcessRestarter : Pm2ProcessRestarter,
    },
    {
      provide: OTA,
      useClass: mode === 'stub' ? StubOtaAdapter : ShellOtaAdapter,
    },
    {
      provide: SYSTEM_DEPS,
      useClass: mode === 'stub' ? StubSystemDepsAdapter : ShellSystemDepsAdapter,
    },
    { provide: CLOCK_SYNC_PROBE, useClass: TimedatectlClockSyncAdapter },
  ],
  exports: [
    SYSTEM_HEALTH,
    SYSTEM_META_REPOSITORY,
    PROCESS_RESTARTER,
    OTA,
    SYSTEM_DEPS,
    CLOCK_SYNC_PROBE,
    BootRecoveryService,
    GracefulShutdownService,
  ],
})
export class SystemModule {}

