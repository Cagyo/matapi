import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { SensorModule } from './sensors/sensor.module';
import { EventModule } from './events/event.module';
import { BotModule } from './telegram/bot.module';
import { CameraModule } from './camera/camera.module';
import { NetworkModule } from './network/network.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    SensorModule,
    EventModule,
    BotModule,
    CameraModule,
    NetworkModule,
  ],
})
export class AppModule {}
