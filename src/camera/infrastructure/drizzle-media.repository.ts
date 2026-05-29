import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { cameras, motionEvents } from '../../database/schema';
import { Camera } from '../domain/camera.entity';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  MediaRepositoryPort,
  UploadStats,
} from '../domain/ports/media-repository.port';

type CameraRow = typeof cameras.$inferSelect;
type MotionEventRow = typeof motionEvents.$inferSelect;

/** Production `MediaRepositoryPort` over the SQLite `cameras`/`motion_events` tables. */
@Injectable()
export class DrizzleMediaRepository implements MediaRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async listCameras(): Promise<Camera[]> {
    return this.db
      .select()
      .from(cameras)
      .where(eq(cameras.enabled, true))
      .all()
      .map((row) => this.toCamera(row));
  }

  async findCameraByName(name: string): Promise<Camera | null> {
    const target = name.trim().toLowerCase();
    const row = this.db
      .select()
      .from(cameras)
      .all()
      .find((c) => c.name.toLowerCase() === target);
    return row ? this.toCamera(row) : null;
  }

  async findEventById(id: number): Promise<MotionEvent | null> {
    const row = this.db
      .select()
      .from(motionEvents)
      .where(eq(motionEvents.id, id))
      .get();
    return row ? this.toEvent(row) : null;
  }

  async listEventsOnDay(day: Date): Promise<MotionEvent[]> {
    const { start, end } = dayBounds(day);
    return this.db
      .select()
      .from(motionEvents)
      .where(and(gte(motionEvents.startedAt, start), lt(motionEvents.startedAt, end)))
      .orderBy(asc(motionEvents.startedAt))
      .all()
      .map((row) => this.toEvent(row));
  }

  async countEventsOnDay(day: Date): Promise<number> {
    return (await this.listEventsOnDay(day)).length;
  }

  async lastEvent(): Promise<MotionEvent | null> {
    const row = this.db
      .select()
      .from(motionEvents)
      .orderBy(desc(motionEvents.startedAt))
      .limit(1)
      .get();
    return row ? this.toEvent(row) : null;
  }

  async uploadStats(): Promise<UploadStats> {
    const pending = this.db
      .select()
      .from(motionEvents)
      .where(eq(motionEvents.uploadedToGdrive, false))
      .all()
      .filter((row) => row.videoPath !== null && row.localDeleted !== true).length;

    return { pending, lastUploadAt: null };
  }

  private toCamera(row: CameraRow): Camera {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      config: (row.config as Record<string, unknown> | null) ?? null,
      enabled: row.enabled ?? true,
    };
  }

  private toEvent(row: MotionEventRow): MotionEvent {
    return {
      id: row.id,
      cameraId: row.cameraId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      videoPath: row.videoPath,
      snapshotPath: row.snapshotPath,
      uploadedToGdrive: row.uploadedToGdrive ?? false,
      gdriveFileId: row.gdriveFileId,
      localDeleted: row.localDeleted ?? false,
    };
  }
}

/** Local-time day window `[00:00, next 00:00)` for the given date. */
function dayBounds(day: Date): { start: Date; end: Date } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
