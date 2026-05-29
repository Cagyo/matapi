import { Injectable } from '@nestjs/common';
import { Camera } from '../domain/camera.entity';
import { MotionEvent } from '../domain/motion-event.entity';
import {
  MediaRepositoryPort,
  UploadStats,
} from '../domain/ports/media-repository.port';

/** In-memory `MediaRepositoryPort` for tests and dev. */
@Injectable()
export class InMemoryMediaRepository implements MediaRepositoryPort {
  private readonly cameras: Camera[] = [];
  private readonly events: MotionEvent[] = [];

  seedCameras(cameras: Camera[]): void {
    this.cameras.splice(0, this.cameras.length, ...cameras);
  }

  seedEvents(events: MotionEvent[]): void {
    this.events.splice(0, this.events.length, ...events);
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
