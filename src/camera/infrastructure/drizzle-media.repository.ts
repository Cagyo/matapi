import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { cameras, motionEvents } from '../../database/schema';
import { Camera } from '../domain/camera.entity';
import { cameraNameKey } from '../domain/camera-name-key';
import { CameraNameTakenError } from '../domain/errors/camera-name-taken.error';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  BrowseMotionEvent,
  MediaRepositoryPort,
  UploadStats,
} from '../domain/ports/media-repository.port';
import { MediaWriterPort } from '../domain/ports/media-writer.port';

/** better-sqlite3 surfaces a violated unique index under this code. */
function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

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
      .values({ cameraId, startedAt, localDeleted: false })
      .returning()
      .get();
    return this.toEvent(row);
  }

  async createCompletedEvent(
    cameraId: string | null,
    startedAt: Date,
    endedAt: Date,
    videoPath: string,
  ): Promise<MotionEvent> {
    const row = this.db
      .insert(motionEvents)
      .values({ cameraId, startedAt, endedAt, videoPath, localDeleted: false })
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
    const target = cameraNameKey(name);
    // Deliberately still a scan (task 5). `backfillNameKeys` now runs before
    // the first camera mutation, but it is allowed to refuse — colliding legacy
    // names leave every key unclaimed — and that refusal must not take the
    // worker down. An indexed-only lookup would then miss every legacy camera,
    // so the canonical fallback stays. The table holds a handful of rows; the
    // unique index remains the authority for writes, which is what the port
    // contract actually requires.
    const row = this.db
      .select()
      .from(cameras)
      .all()
      .find((c) => (c.nameKey ?? cameraNameKey(c.name)) === target);
    return row ? this.toCamera(row) : null;
  }

  async backfillNameKeys(): Promise<void> {
    try {
      this.db.transaction((tx) => {
        const rows = tx
          .select({ id: cameras.id, name: cameras.name, nameKey: cameras.nameKey })
          .from(cameras)
          .orderBy(asc(cameras.id))
          .all();
        for (const row of rows) {
          if (row.nameKey !== null) continue;
          tx.update(cameras)
            .set({ nameKey: cameraNameKey(row.name) })
            .where(eq(cameras.id, row.id))
            .run();
        }
      });
    } catch (error) {
      // The unique index — not a scan — decides collisions; the throw rolls the
      // whole backfill back, and the name never reaches the mapped error.
      if (isUniqueViolation(error)) throw new CameraNameTakenError();
      throw error;
    }
  }

  async findEventById(id: number): Promise<MotionEvent | null> {
    const row = this.db
      .select()
      .from(motionEvents)
      .where(eq(motionEvents.id, id))
      .get();
    return row ? this.toEvent(row) : null;
  }

  async findUnarchivedCompletedVideos(limit: number): Promise<MotionEvent[]> {
    return this.db
      .select()
      .from(motionEvents)
      .where(and(
        isNotNull(motionEvents.endedAt),
        isNotNull(motionEvents.videoPath),
        isNull(motionEvents.archiveArtifactId),
      ))
      .orderBy(asc(motionEvents.startedAt))
      .limit(limit)
      .all()
      .map((row) => this.toEvent(row));
  }

  async findCompletedEventsByVideoPath(videoPath: string): Promise<MotionEvent[]> {
    return this.db
      .select()
      .from(motionEvents)
      .where(and(
        eq(motionEvents.videoPath, videoPath),
        isNotNull(motionEvents.endedAt),
        isNull(motionEvents.archiveArtifactId),
      ))
      .all()
      .map((row) => this.toEvent(row));
  }

  async findEventsByVideoPath(videoPath: string): Promise<MotionEvent[]> {
    return this.db
      .select()
      .from(motionEvents)
      .where(and(eq(motionEvents.videoPath, videoPath), isNotNull(motionEvents.endedAt)))
      .all()
      .map((row) => this.toEvent(row));
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
      .where(isNull(motionEvents.archiveArtifactId))
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
          isNull(motionEvents.archiveArtifactId),
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
      .where(and(
        isNotNull(motionEvents.archiveArtifactId),
        eq(motionEvents.localDeleted, false),
      ))
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
    void id;
    void remotePath;
    // Archive attempt verification owns remote state; this compatibility seam
    // is retained for rollback readability while the archive manifest is authoritative.
  }

  async attachArchiveArtifact(eventIds: number[], archiveArtifactId: string): Promise<void> {
    if (eventIds.length === 0) return;
    this.db
      .update(motionEvents)
      .set({ archiveArtifactId })
      .where(and(inArray(motionEvents.id, eventIds), isNull(motionEvents.archiveArtifactId)))
      .run();
  }

  async deferArchiveRegistration(_eventIds: number[]): Promise<void> {
    // A null reference is the durable deferred state and is picked up by reconcile().
  }

  async markLocalDeleted(id: number): Promise<void> {
    this.db
      .update(motionEvents)
      .set({ localDeleted: true })
      .where(eq(motionEvents.id, id))
      .run();
  }

  async clearGdriveForEventsOlderThan(cutoff: Date): Promise<number> {
    void cutoff;
    return 0;
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
      archiveArtifactId: row.archiveArtifactId,
      archiveWebViewLink: null,
      uploadedToGdrive: false,
      gdriveFileId: null,
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
