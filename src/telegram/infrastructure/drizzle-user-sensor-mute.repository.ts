import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { userSensorMutes } from '../../database/schema';
import { UserSensorMuteRepositoryPort } from '../domain/ports/user-sensor-mute-repository.port';

@Injectable()
export class DrizzleUserSensorMuteRepository
  implements UserSensorMuteRepositoryPort
{
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async isMuted(userId: number, sensorId: string): Promise<boolean> {
    const row = this.db
      .select({ sensorId: userSensorMutes.sensorId })
      .from(userSensorMutes)
      .where(
        and(
          eq(userSensorMutes.userId, userId),
          eq(userSensorMutes.sensorId, sensorId),
        ),
      )
      .get();
    return row !== undefined;
  }

  async mute(userId: number, sensorId: string): Promise<void> {
    this.db
      .insert(userSensorMutes)
      .values({ userId, sensorId })
      .onConflictDoNothing()
      .run();
  }

  async unmute(userId: number, sensorId: string): Promise<void> {
    this.db
      .delete(userSensorMutes)
      .where(
        and(
          eq(userSensorMutes.userId, userId),
          eq(userSensorMutes.sensorId, sensorId),
        ),
      )
      .run();
  }

  async listForUser(userId: number): Promise<string[]> {
    return this.db
      .select({ sensorId: userSensorMutes.sensorId })
      .from(userSensorMutes)
      .where(eq(userSensorMutes.userId, userId))
      .all()
      .map((row) => row.sensorId)
      .filter((id): id is string => id !== null);
  }

  async countForUser(userId: number): Promise<number> {
    const [{ value }] = this.db
      .select({ value: count() })
      .from(userSensorMutes)
      .where(eq(userSensorMutes.userId, userId))
      .all();
    return value;
  }
}
