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
      'findEventById' | 'findUnarchivedCompletedVideos' | 'findCompletedEventsByVideoPath' | 'findEventsByVideoPath'>,
    @Inject(COMPLETED_MOTION_VIDEO) private readonly completedVideos: CompletedMotionVideoPort,
    @Inject(ARCHIVE_REGISTRATION) private readonly archive: ArchiveRegistrationPort,
    private readonly installationId: string | null,
    @Inject(MEDIA_WRITER) private readonly writer?: Pick<MediaWriterPort,
      'createCompletedEvent' | 'attachArchiveArtifact' | 'deferArchiveRegistration'>,
  ) {}

  async executeForEvent(eventId: number): Promise<void> {
    const event = await this.media.findEventById(eventId);
    if (!event?.videoPath || !event.endedAt || event.archiveArtifactId) return;
    await this.registerPath(event.videoPath, [event.id]);
  }

  async reconcile(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const processedPaths = new Set<string>();
    const grouped = new Map<string, {
      descriptor: CompletedMotionVideoDescriptor;
      eventIds: Set<number>;
    }>();
    const pending = await this.media.findUnarchivedCompletedVideos(RECONCILIATION_LIMIT);
    throwIfAborted(signal);
    for (const event of pending) {
      throwIfAborted(signal);
      if (!event.videoPath || processedPaths.has(event.videoPath)) continue;
      processedPaths.add(event.videoPath);
      const descriptor = await this.completedVideos.resolve(event.videoPath);
      throwIfAborted(signal);
      if (!descriptor) {
        await this.requireWriter().deferArchiveRegistration([event.id]);
        throwIfAborted(signal);
        continue;
      }
      const matching = await this.media.findCompletedEventsByVideoPath(descriptor.trustedPath);
      throwIfAborted(signal);
      if (await this.hasReferencedEvent(descriptor.trustedPath)) {
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      this.groupDescriptor(
        grouped,
        descriptor,
        matching.length > 0 ? matching.map((candidate) => candidate.id) : [event.id],
      );
    }

    const scanned = await this.completedVideos.scan(RECONCILIATION_LIMIT);
    throwIfAborted(signal);
    for (const descriptor of scanned) {
      throwIfAborted(signal);
      if (processedPaths.has(descriptor.trustedPath)) continue;
      processedPaths.add(descriptor.trustedPath);
      const matching = await this.media.findCompletedEventsByVideoPath(descriptor.trustedPath);
      throwIfAborted(signal);
      if (await this.hasReferencedEvent(descriptor.trustedPath)) {
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      const eventIds = matching.map((event) => event.id);
      if (eventIds.length === 0) {
        const created = await this.requireWriter().createCompletedEvent(
          null,
          new Date(descriptor.sourceTimeMs),
          new Date(descriptor.sourceTimeMs),
          descriptor.trustedPath,
        );
        throwIfAborted(signal);
        eventIds.push(created.id);
      }
      this.groupDescriptor(grouped, descriptor, eventIds);
    }

    for (const { descriptor, eventIds } of grouped.values()) {
      throwIfAborted(signal);
      await this.registerDescriptor(descriptor, [...eventIds]);
      throwIfAborted(signal);
    }
  }

  private async registerPath(path: string, fallbackEventIds: readonly number[]): Promise<void> {
    const descriptor = await this.completedVideos.resolve(path);
    if (!descriptor) {
      await this.requireWriter().deferArchiveRegistration([...fallbackEventIds]);
      return;
    }
    const matching = await this.media.findCompletedEventsByVideoPath(descriptor.trustedPath);
    if (await this.hasReferencedEvent(descriptor.trustedPath)) return;
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

  private async hasReferencedEvent(videoPath: string): Promise<boolean> {
    return (await this.media.findEventsByVideoPath(videoPath)).some(
      (event) => event.archiveArtifactId !== null,
    );
  }

  private toArchiveArtifact(descriptor: CompletedMotionVideoDescriptor): RegisterArchiveArtifact {
    if (!this.installationId) throw new Error('Archive installation identity is unavailable');
    return { installationId: this.installationId, ...descriptor };
  }

  private requireWriter(): Pick<MediaWriterPort,
    'createCompletedEvent' | 'attachArchiveArtifact' | 'deferArchiveRegistration'> {
    if (!this.writer) throw new Error('Motion archive writer is not configured');
    return this.writer;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}
