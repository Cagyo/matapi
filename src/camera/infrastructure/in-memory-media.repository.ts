import { Injectable } from '@nestjs/common';
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
import type {
  InMemoryCameraRow,
  InMemoryCameraStore,
} from './in-memory-rtsp-source-configuration.adapter';

/**
 * In-memory adapter for tests and dev. Serves both read and write ports, and
 * the synchronous camera store the RTSP source-configuration twin writes
 * through, so stub composition keeps one set of camera rows rather than two.
 */
@Injectable()
export class InMemoryMediaRepository
  implements MediaRepositoryPort, MediaWriterPort, InMemoryCameraStore
{
  private readonly cameras: Camera[] = [];
  private readonly events: MotionEvent[] = [];
  private nextId = 1;

  seedCameras(cameras: Camera[]): void {
    this.cameras.splice(0, this.cameras.length, ...cameras);
  }

  seedEvents(events: MotionEvent[]): void {
    this.events.splice(0, this.events.length, ...events);
    this.nextId =
      events.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  async createEvent(cameraId: string | null, startedAt: Date): Promise<MotionEvent> {
    const event: MotionEvent = {
      id: this.nextId++,
      cameraId,
      startedAt,
      endedAt: null,
      videoPath: null,
      snapshotPath: null,
      archiveArtifactId: null,
      archiveWebViewLink: null,
      uploadedToGdrive: false,
      gdriveFileId: null,
      localDeleted: false,
    };
    this.events.push(event);
    return event;
  }

  async closeLatestOpenEvent(
    cameraId: string | null,
    endedAt: Date,
    videoPath: string,
  ): Promise<MotionEvent | null> {
    const open = this.latestOpen(cameraId);
    if (!open) return null;
    open.endedAt = endedAt;
    open.videoPath = videoPath;
    return open;
  }

  async createCompletedEvent(
    cameraId: string | null,
    startedAt: Date,
    endedAt: Date,
    videoPath: string,
  ): Promise<MotionEvent> {
    const event: MotionEvent = {
      id: this.nextId++, cameraId, startedAt, endedAt, videoPath,
      snapshotPath: null, archiveArtifactId: null, uploadedToGdrive: false,
      archiveWebViewLink: null, gdriveFileId: null, localDeleted: false,
    };
    this.events.push(event);
    return event;
  }

  async setSnapshotForLatestOpenEvent(
    snapshotPath: string,
  ): Promise<MotionEvent | null> {
    const open = this.latestOpen(null);
    if (!open) return null;
    open.snapshotPath = snapshotPath;
    return open;
  }

  private latestOpen(cameraId: string | null): MotionEvent | undefined {
    return [...this.events]
      .filter(
        (e) =>
          e.endedAt === null &&
          e.startedAt !== null &&
          (cameraId === null || e.cameraId === cameraId),
      )
      .sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime())[0];
  }

  async listCameras(): Promise<Camera[]> {
    return this.cameras.filter((c) => c.enabled);
  }

  /**
   * Synchronous camera-store surface (`InMemoryCameraStore`). Seeded cameras
   * carry no stored key, so the canonical one is derived on read exactly as
   * `findCameraByName` derives it.
   */
  allCameras(): readonly InMemoryCameraRow[] {
    return this.cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      nameKey: cameraNameKey(camera.name),
      type: camera.type,
      enabled: camera.enabled,
    }));
  }

  addCamera(camera: InMemoryCameraRow): void {
    this.cameras.push({
      id: camera.id,
      name: camera.name,
      type: camera.type,
      config: null,
      enabled: camera.enabled,
    });
  }

  removeCamera(cameraId: string): void {
    const index = this.cameras.findIndex((camera) => camera.id === cameraId);
    if (index >= 0) this.cameras.splice(index, 1);
    // Mirrors the SQL removal: recorded media survives, attribution does not.
    for (const event of this.events) {
      if (event.cameraId === cameraId) event.cameraId = null;
    }
  }

  async findCameraByName(name: string): Promise<Camera | null> {
    const target = cameraNameKey(name);
    return this.cameras.find((c) => cameraNameKey(c.name) === target) ?? null;
  }

  /**
   * Seeded cameras carry no stored key — lookups canonicalize `name` on every
   * read — so the backfill has nothing to write and only has to agree with the
   * Drizzle adapter on which legacy sets it refuses.
   */
  async backfillNameKeys(): Promise<void> {
    const claimed = new Set<string>();
    for (const camera of this.cameras) {
      const key = cameraNameKey(camera.name);
      if (claimed.has(key)) throw new CameraNameTakenError();
      claimed.add(key);
    }
  }

  async findEventById(id: number): Promise<MotionEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async findUnarchivedCompletedVideos(limit: number): Promise<MotionEvent[]> {
    return this.events
      .filter((event) => event.endedAt !== null && event.videoPath !== null && event.archiveArtifactId === null)
      .sort((left, right) => (left.startedAt?.getTime() ?? 0) - (right.startedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async findCompletedEventsByVideoPath(videoPath: string): Promise<MotionEvent[]> {
    return this.events.filter((event) =>
      event.endedAt !== null && event.videoPath === videoPath && event.archiveArtifactId === null,
    );
  }

  async findEventsByVideoPath(videoPath: string): Promise<MotionEvent[]> {
    return this.events.filter((event) => event.endedAt !== null && event.videoPath === videoPath);
  }

  async listEventsOnDay(day: Date): Promise<MotionEvent[]> {
    const { start, end } = dayBounds(day);
    return this.events
      .filter((e) => e.startedAt && e.startedAt >= start && e.startedAt < end)
      .sort((a, b) => (a.startedAt!.getTime() - b.startedAt!.getTime()));
  }

  async listLatestEvents(limit: number): Promise<BrowseMotionEvent[]> {
    return [...this.events]
      .filter((e) => e.startedAt !== null)
      .sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime())
      .map((event) => this.toBrowseEvent(event))
      .slice(0, limit);
  }

  async listEventsStartedBetween(
    start: Date,
    end: Date,
    limit: number,
  ): Promise<BrowseMotionEvent[]> {
    return this.events
      .filter((e) => e.startedAt && e.startedAt >= start && e.startedAt < end)
      .sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime())
      .map((event) => this.toBrowseEvent(event))
      .slice(0, limit);
  }

  private toBrowseEvent(event: MotionEvent): BrowseMotionEvent {
    return {
      ...event,
      cameraName:
        event.cameraId === null
          ? null
          : this.cameras.find((camera) => camera.id === event.cameraId)?.name ?? null,
    };
  }

  async countEventsOnDay(day: Date): Promise<number> {
    return (await this.listEventsOnDay(day)).length;
  }

  async lastEvent(): Promise<MotionEvent | null> {
    return (
      [...this.events]
        .filter((e) => e.startedAt)
        .sort((a, b) => b.startedAt!.getTime() - a.startedAt!.getTime())[0] ?? null
    );
  }

  async uploadStats(): Promise<UploadStats> {
    const pending = this.events.filter(
      (e) => !e.uploadedToGdrive && e.videoPath !== null && !e.localDeleted,
    ).length;
    return { pending, lastUploadAt: null };
  }

  async findPendingUploads(): Promise<MotionEvent[]> {
    return this.events
      .filter(
        (e) =>
          !e.uploadedToGdrive &&
          !e.localDeleted &&
          e.videoPath !== null &&
          e.endedAt !== null,
      )
      .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  }

  async findUploadedNotDeleted(): Promise<MotionEvent[]> {
    return this.events
      .filter((e) => e.archiveArtifactId !== null && !e.localDeleted)
      .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  }

  async listAllMediaPaths(): Promise<string[]> {
    return this.events
      .flatMap((e) => [e.videoPath, e.snapshotPath])
      .filter((p): p is string => p !== null);
  }

  async markUploaded(id: number, remotePath: string): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) {
      event.uploadedToGdrive = true;
      event.gdriveFileId = remotePath;
    }
  }

  async attachArchiveArtifact(eventIds: number[], archiveArtifactId: string): Promise<void> {
    for (const event of this.events) {
      if (eventIds.includes(event.id) && event.archiveArtifactId === null) {
        event.archiveArtifactId = archiveArtifactId;
      }
    }
  }

  async deferArchiveRegistration(_eventIds: number[]): Promise<void> {
    // Keeping the nullable reference untouched makes the row eligible for recovery.
  }

  async markLocalDeleted(id: number): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) event.localDeleted = true;
  }

  async clearGdriveForEventsOlderThan(cutoff: Date): Promise<number> {
    let changed = 0;
    for (const e of this.events) {
      if (e.startedAt && e.startedAt < cutoff && e.gdriveFileId !== null) {
        e.gdriveFileId = null;
        changed += 1;
      }
    }
    return changed;
  }
}

function dayBounds(day: Date): { start: Date; end: Date } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
