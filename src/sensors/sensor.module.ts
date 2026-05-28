import { Module } from '@nestjs/common';
import { SensorRegistry } from './sensor.registry';
import { PigpioGateway } from './drivers/pigpio.gateway';

@Module({
  providers: [SensorRegistry, PigpioGateway],
  exports: [SensorRegistry, PigpioGateway],
})
export class SensorModule {}
