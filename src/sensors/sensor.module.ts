import { Module } from '@nestjs/common';
import { SensorRegistry } from './sensor.registry';

@Module({
  providers: [SensorRegistry],
  exports: [SensorRegistry],
})
export class SensorModule {}
