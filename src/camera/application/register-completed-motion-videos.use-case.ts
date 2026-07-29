import { Inject, Injectable } from '@nestjs/common';
import type { RegisterArchiveArtifact } from '../../archive/domain/archive-artifact.entity';
import {
  ARCHIVE_REGISTRATION,
  type ArchiveRegistrationPort,
} from '../../archive/application/ports/archive-registration.port';
import {
  COMPLETED_MOTION_VIDEO,
  type CompletedMotionVideoDescriptor,
  type CompletedMotionVideoPort,
} from '../domain/ports/completed-motion-video.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import {
  MEDIA_WRITER,
  type MediaWriterPort,
} from '../domain/ports/media-writer.port';

const RECONCILIATION_LIMIT = 64;

/** Registers validated Motion files and makes DB event rows point at the artifact. */
@Injectable()
export class RegisterCompletedMotionVideosUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: Pick<MediaRepositoryPort,
      'findEventById' | 'findUnarchivedCompletedVideos' | 'findCompletedEventsByVideoPath'>,
    @Inject(COMPLETED_MOTION_VIDEO) private readonly completedVideos: CompletedMotionVideoPort,
    @Inject(ARCHIVE_REGISTRATION) private readonly archive: ArchiveRegistrationPort,
    private readonly installationId: string,
    @Inject(MEDIA_WRITER) private readonly writer?: Pick<MediaWriterPort,
      'createCompletedEvent' | 'attachArchiveArtifact' | 'deferArchiveRegistration'>,
  ) {}

  async executeForEvent(eventId: number): Promise<void> {
    const event = await this.media.findEventById(eventId);
    if (!event || !event.videoPath || !event.endedAt || event.archiveArtifactId) return;
    await this.registerPath(event.videoPath, [event.id]);
  }

  async reconcile(): Promise<void> {
    const processedPaths = new Set<string>();
    const grouped = new Map<string, {
      descriptor: CompletedMotionVideoDescriptor;
      eventIds: Set<number>;
    }>();
    const pending = await this.media.findUnarchivedCompletedVideos(RECONCILIATION_LIMIT);
    for (const event of pending) {
      if (!event.videoPath || processedPaths.has(event.videoPath)) continue;
      processedPaths.add(event.videoPath);
      const descriptor = await this.completedVideos.resolve(event.videoPath);
      if (!descriptor) {
        await this.requireWriter().deferArchiveRegistration([event.id]);
        continue;
      }
      const matching = await this.media.findCompletedEventsByVideoPath(descriptor.trustedPath);
      this.groupDescriptor(
        grouped,
        descriptor,
        matching.length > 0 ? matching.map((candidate) => candidate.id) : [event.id],
      );
    }

    for (const descriptor of await this.completedVideos.scan(RECONCILIATION_LIMIT)) {
      if (processedPaths.has(descriptor.trustedPath)) continue;
      processedPaths.add(descriptor.trustedPath);
      const matching = await this.media.findCompletedEventsByVideoPath(descriptor.trustedPath);
      const eventIds = matching.map((event) => event.id);
      if (eventIds.length === 0) {
        const created = await this.requireWriter().createCompletedEvent(
          null,
          new Date(descriptor.sourceTimeMs),
          new Date(descriptor.sourceTimeMs),
          descriptor.trustedPath,
        );
        eventIds.push(created.id);
      }
      this.groupDescriptor(grouped, descriptor, eventIds);
    }

    for (const { descriptor, eventIds } of grouped.values()) {
      await this.registerDescriptor(descriptor, [...eventIds]);
    }
  }

  private async registerPath(path: string, fallbackEventIds: readonly number[]): Promise<void> {
    const descriptor = await this.completedVideos.resolve(path);
    if (!descriptor) {
      await this.requireWriter().deferArchiveRegistration([...fallbackEventIds]);
      return;
    }
    const matching = await this.media.findCompletedEventsByVideoPath(descriptor.trustedPath);
    await this.registerDescriptor(descriptor, matching.length > 0 ? matching.map((event) => event.id) : fallbackEventIds);
  }

  private async registerDescriptor(
    descriptor: CompletedMotionVideoDescriptor,
    eventIds: readonly number[],
  ): Promise<void> {
    const artifact = await this.archive.register(this.toArchiveArtifact(descriptor));
    await this.requireWriter().attachArchiveArtifact([...new Set(eventIds)], artifact.id);
  }

  private groupDescriptor(
    groups: Map<string, { descriptor: CompletedMotionVideoDescriptor; eventIds: Set<number> }>,
    descriptor: CompletedMotionVideoDescriptor,
    eventIds: readonly number[],
  ): void {
    const existing = groups.get(descriptor.sourceFingerprint);
    if (existing) {
      eventIds.forEach((id) => existing.eventIds.add(id));
      return;
    }
    groups.set(descriptor.sourceFingerprint, { descriptor, eventIds: new Set(eventIds) });
  }

  private toArchiveArtifact(descriptor: CompletedMotionVideoDescriptor): RegisterArchiveArtifact {
    return { installationId: this.installationId, ...descriptor };
  }

  private requireWriter(): Pick<MediaWriterPort,
    'createCompletedEvent' | 'attachArchiveArtifact' | 'deferArchiveRegistration'> {
    if (!this.writer) throw new Error('Motion archive writer is not configured');
    return this.writer;
  }
}
