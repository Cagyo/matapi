import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { cameras, motionEvents } from '../../database/schema';
import { Camera } from '../domain/camera.entity';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  BrowseMotionEvent,
  MediaRepositoryPort,
  UploadStats,
} from '../domain/ports/media-repository.port';
import { MediaWriterPort } from '../domain/ports/media-writer.port';

type CameraRow = typeof cameras.$inferSelect;
type MotionEventRow = typeof motionEvents.$inferSelect;

/**
 * Production adapter over the SQLite `cameras`/`motion_events` tables. Serves
 * both the read-only `MediaRepositoryPort` (bot commands) and the write-side
 * `MediaWriterPort` (Motion daemon hooks, spec 20).
 */
@Injectable()
export class DrizzleMediaRepository implements MediaRepositoryPort, MediaWriterPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async createEvent(cameraId: string | null, startedAt: Date): Promise<MotionEvent> {
    const row = this.db
      .insert(motionEvents)
      .values({ cameraId, startedAt, uploadedToGdrive: false, localDeleted: false })
      .returning()
      .get();
    return this.toEvent(row);
  }

  async closeLatestOpenEvent(
    cameraId: string | null,
    endedAt: Date,
    videoPath: string,
  ): Promise<MotionEvent | null> {
    const open = this.latestOpen(cameraId);
    if (!open) return null;
    const row = this.db
      .update(motionEvents)
      .set({ endedAt, videoPath })
      .where(eq(motionEvents.id, open.id))
      .returning()
      .get();
    return row ? this.toEvent(row) : null;
  }

  async setSnapshotForLatestOpenEvent(
    snapshotPath: string,
  ): Promise<MotionEvent | null> {
    const open = this.latestOpen(null);
    if (!open) return null;
    const row = this.db
      .update(motionEvents)
      .set({ snapshotPath })
      .where(eq(motionEvents.id, open.id))
      .returning()
      .get();
    return row ? this.toEvent(row) : null;
  }

  /** Most recent event with no `endedAt`, optionally scoped to a camera. */
  private latestOpen(cameraId: string | null): MotionEventRow | undefined {
    const where =
      cameraId === null
        ? isNull(motionEvents.endedAt)
        : and(isNull(motionEvents.endedAt), eq(motionEvents.cameraId, cameraId));
    return this.db
      .select()
      .from(motionEvents)
      .where(where)
      .orderBy(desc(motionEvents.startedAt))
      .limit(1)
      .get();
  }

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

  async listLatestEvents(limit: number): Promise<BrowseMotionEvent[]> {
    return this.db
      .select({ event: motionEvents, cameraName: cameras.name })
      .from(motionEvents)
      .leftJoin(cameras, eq(motionEvents.cameraId, cameras.id))
      .where(isNotNull(motionEvents.startedAt))
      .orderBy(desc(motionEvents.startedAt))
      .limit(limit)
      .all()
      .map((row) => this.toBrowseEvent(row));
  }

  async listEventsStartedBetween(
    start: Date,
    end: Date,
    limit: number,
  ): Promise<BrowseMotionEvent[]> {
    return this.db
      .select({ event: motionEvents, cameraName: cameras.name })
      .from(motionEvents)
      .leftJoin(cameras, eq(motionEvents.cameraId, cameras.id))
      .where(and(gte(motionEvents.startedAt, start), lt(motionEvents.startedAt, end)))
      .orderBy(desc(motionEvents.startedAt))
      .limit(limit)
      .all()
      .map((row) => this.toBrowseEvent(row));
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

  async findPendingUploads(): Promise<MotionEvent[]> {
    return this.db
      .select()
      .from(motionEvents)
      .where(
        and(
          eq(motionEvents.uploadedToGdrive, false),
          eq(motionEvents.localDeleted, false),
          isNotNull(motionEvents.videoPath),
          isNotNull(motionEvents.endedAt),
        ),
      )
      .orderBy(asc(motionEvents.startedAt))
      .all()
      .map((row) => this.toEvent(row));
  }

  async findUploadedNotDeleted(): Promise<MotionEvent[]> {
    return this.db
      .select()
      .from(motionEvents)
      .where(
        and(
          eq(motionEvents.uploadedToGdrive, true),
          eq(motionEvents.localDeleted, false),
        ),
      )
      .orderBy(asc(motionEvents.startedAt))
      .all()
      .map((row) => this.toEvent(row));
  }

  async listAllMediaPaths(): Promise<string[]> {
    const rows = this.db
      .select({
        videoPath: motionEvents.videoPath,
        snapshotPath: motionEvents.snapshotPath,
      })
      .from(motionEvents)
      .all();
    return rows
      .flatMap((row) => [row.videoPath, row.snapshotPath])
      .filter((p): p is string => p !== null);
  }

  async markUploaded(id: number, remotePath: string): Promise<void> {
    this.db
      .update(motionEvents)
      .set({ uploadedToGdrive: true, gdriveFileId: remotePath })
      .where(eq(motionEvents.id, id))
      .run();
  }

  async markLocalDeleted(id: number): Promise<void> {
    this.db
      .update(motionEvents)
      .set({ localDeleted: true })
      .where(eq(motionEvents.id, id))
      .run();
  }

  async clearGdriveForEventsOlderThan(cutoff: Date): Promise<number> {
    const result = this.db
      .update(motionEvents)
      .set({ gdriveFileId: null })
      .where(
        and(lt(motionEvents.startedAt, cutoff), isNotNull(motionEvents.gdriveFileId)),
      )
      .run();
    return result.changes;
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

  private toBrowseEvent(row: {
    event: MotionEventRow;
    cameraName: string | null;
  }): BrowseMotionEvent {
    return {
      ...this.toEvent(row.event),
      cameraName: row.cameraName,
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
