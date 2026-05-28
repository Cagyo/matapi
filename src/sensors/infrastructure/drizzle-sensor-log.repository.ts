import { Inject, Injectable } from '@nestjs/common';
import { AppDatabase, DB } from '../../database/database.module';
import { sensorLogs } from '../../database/schema';
import {
  SensorLogEntry,
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';

@Injectable()
export class DrizzleSensorLogRepository implements SensorLogRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async appendBatch(entries: SensorLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.db.insert(sensorLogs).values(entries).run();
  }
}
