import { Module } from '@nestjs/common';
import { SYSTEM_HEALTH } from './domain/ports/system-health.port';
import { OsSystemHealthAdapter } from './infrastructure/os-system-health.adapter';

/**
 * Cross-cutting `system/` context — exposes OS-level metrics to other
 * contexts via `SystemHealthPort`. The bot `/health` handler is the
 * primary consumer today (spec 08).
 */
@Module({
  providers: [{ provide: SYSTEM_HEALTH, useClass: OsSystemHealthAdapter }],
  exports: [SYSTEM_HEALTH],
})
export class SystemModule {}
