import { Module } from '@nestjs/common';
import { SensorModule } from '../sensors/sensor.module';
import { EventQueue } from './event.queue';
import { EventProcessor } from './event.processor';

@Module({
  imports: [SensorModule],
  providers: [EventQueue, EventProcessor],
  exports: [EventQueue, EventProcessor],
})
export class EventModule {}
