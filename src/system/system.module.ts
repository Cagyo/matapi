import { Module } from '@nestjs/common';
import { OTA } from './domain/ports/ota.port';
import { PROCESS_RESTARTER } from './domain/ports/process-restarter.port';
import { SYSTEM_META_REPOSITORY } from './domain/ports/system-meta-repository.port';
import { SYSTEM_HEALTH } from './domain/ports/system-health.port';
import { DrizzleSystemMetaRepository } from './infrastructure/drizzle-system-meta.repository';
import { OsSystemHealthAdapter } from './infrastructure/os-system-health.adapter';
import { Pm2ProcessRestarter } from './infrastructure/pm2-process-restarter.adapter';
import { ShellOtaAdapter } from './infrastructure/shell-ota.adapter';

/**
 * Cross-cutting `system/` context — exposes OS-level metrics, OTA control
 * and process-restart capability to other contexts via ports.
 */
@Module({
  providers: [
    { provide: SYSTEM_HEALTH, useClass: OsSystemHealthAdapter },
    { provide: SYSTEM_META_REPOSITORY, useClass: DrizzleSystemMetaRepository },
    { provide: PROCESS_RESTARTER, useClass: Pm2ProcessRestarter },
    { provide: OTA, useClass: ShellOtaAdapter },
  ],
  exports: [SYSTEM_HEALTH, SYSTEM_META_REPOSITORY, PROCESS_RESTARTER, OTA],
})
export class SystemModule {}
