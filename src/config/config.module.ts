import { Module } from '@nestjs/common';
import { TIMEZONE_OPTIONS } from './application/ports/timezone-options.port';
import { timezoneOptionsFromEnv } from './infrastructure/env-timezone-options.adapter';

@Module({
  providers: [{ provide: TIMEZONE_OPTIONS, useFactory: timezoneOptionsFromEnv }],
  exports: [TIMEZONE_OPTIONS],
})
export class ConfigModule {}
