import { Injectable } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  MediaRepositoryPort,
  UploadStats,
} from '../domain/ports/media-repository.port';
import { MediaWriterPort } from '../domain/ports/media-writer.port';

/** In-memory adapter for tests and dev. Serves both read and write ports. */
@Injectable()
export class InMemoryMediaRepository implements MediaRepositoryPort, MediaWriterPort {
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

  async findCameraByName(name: string): Promise<Camera | null> {
    const target = name.trim().toLowerCase();
    return this.cameras.find((c) => c.name.toLowerCase() === target) ?? null;
  }

  async findEventById(id: number): Promise<MotionEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async listEventsOnDay(day: Date): Promise<MotionEvent[]> {
    const { start, end } = dayBounds(day);
    return this.events
      .filter((e) => e.startedAt && e.startedAt >= start && e.startedAt < end)
      .sort((a, b) => (a.startedAt!.getTime() - b.startedAt!.getTime()));
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
}

function dayBounds(day: Date): { start: Date; end: Date } {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
