import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { userSensorMutes } from '../../database/schema';
import { UserSensorMuteRepositoryPort } from '../domain/ports/user-sensor-mute-repository.port';
import type { NotificationTargetRef } from '../domain/home-session';

@Injectable()
export class DrizzleUserSensorMuteRepository
  implements UserSensorMuteRepositoryPort
{
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async isMuted(userId: number, target: NotificationTargetRef | string): Promise<boolean> {
    const sensorId = targetKey(target);
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
    if (row !== undefined || typeof target === 'string' || target.kind !== 'sensor') return row !== undefined;
    const legacy = this.select(userId, target.id);
    if (!legacy) return false;
    this.mute(userId, target);
    this.unmute(userId, target.id);
    return true;
  }

  async mute(userId: number, target: NotificationTargetRef | string): Promise<void> {
    const sensorId = targetKey(target);
    this.db
      .insert(userSensorMutes)
      .values({ userId, sensorId })
      .onConflictDoNothing()
      .run();
  }

  async unmute(userId: number, target: NotificationTargetRef | string): Promise<void> {
    const sensorId = targetKey(target);
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

  async listForUser(userId: number): Promise<NotificationTargetRef[]> {
    const values = this.db
      .select({ sensorId: userSensorMutes.sensorId })
      .from(userSensorMutes)
      .where(eq(userSensorMutes.userId, userId))
      .all()
      .map((row) => row.sensorId)
      .filter((id): id is string => id !== null);
    for (const value of values.filter((value) => !value.startsWith('sensor:') && !value.startsWith('camera:'))) {
      await this.mute(userId, { kind: 'sensor', id: value });
      await this.unmute(userId, value);
    }
    return (await this.db
      .select({ sensorId: userSensorMutes.sensorId })
      .from(userSensorMutes)
      .where(eq(userSensorMutes.userId, userId))
      .all())
      .map((row) => row.sensorId)
      .filter((id): id is string => id !== null)
      .map(parseTarget)
      .filter((target): target is NotificationTargetRef => target !== null);
  }

  async countForUser(userId: number): Promise<number> {
    const [{ value }] = this.db
      .select({ value: count() })
      .from(userSensorMutes)
      .where(eq(userSensorMutes.userId, userId))
      .all();
    return value;
  }

  private select(userId: number, sensorId: string): boolean {
    return this.db.select({ sensorId: userSensorMutes.sensorId }).from(userSensorMutes)
      .where(and(eq(userSensorMutes.userId, userId), eq(userSensorMutes.sensorId, sensorId))).get() !== undefined;
  }
}

function targetKey(target: NotificationTargetRef | string): string {
  return typeof target === 'string' ? target : `${target.kind}:${target.id}`;
}

function parseTarget(value: string): NotificationTargetRef | null {
  const match = /^(sensor|camera):(.+)$/.exec(value);
  return match ? { kind: match[1] as NotificationTargetRef['kind'], id: match[2] } : null;
}
