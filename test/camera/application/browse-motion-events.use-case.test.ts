import { describe, expect, it } from 'vitest';
import {
  BROWSE_MOTION_EVENTS_LIMIT,
  BrowseMotionEventsUseCase,
} from '../../../src/camera/application/browse-motion-events.use-case';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';
import type { ArchiveVerificationPort } from '../../../src/archive/application/ports/archive-verification.port';

function event(id: number, startedAt: string): MotionEvent {
  return {
    id,
    cameraId: 'front_door',
    startedAt: new Date(startedAt),
    endedAt: new Date(new Date(startedAt).getTime() + 30_000),
    videoPath: `/motion/${id}.mp4`,
    snapshotPath: `/motion/${id}.jpg`,
    archiveArtifactId: null,
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
  };
}

function useCase(events: MotionEvent[], archive?: ArchiveVerificationPort): BrowseMotionEventsUseCase {
  const repo = new InMemoryMediaRepository();
  repo.seedEvents(events);
  return new BrowseMotionEventsUseCase(repo, archive ?? {
    inspect: async (artifactId) => ({
      artifactId,
      cleanupSafe: false,
      webViewLink: null,
      reason: 'no-current-attempt',
    }),
  });
}

describe('BrowseMotionEventsUseCase', () => {
  it('returns latest events newest first, capped at the visible limit, with hasMore', async () => {
    const events = Array.from({ length: BROWSE_MOTION_EVENTS_LIMIT + 1 }, (_, index) =>
      event(index + 1, `2026-04-08T12:${String(index).padStart(2, '0')}:00`),
    );

    const result = await useCase(events).latest();

    expect(result.events).toHaveLength(BROWSE_MOTION_EVENTS_LIMIT);
    expect(result.hasMore).toBe(true);
    expect(result.events[0].id).toBe(21);
    expect(result.events.at(-1)?.id).toBe(2);
  });

  it('reports hasMore=false when latest query fits within the visible limit', async () => {
    const result = await useCase([
      event(1, '2026-04-08T12:00:00'),
      event(2, '2026-04-08T12:05:00'),
    ]).latest();

    expect(result.events.map((e) => e.id)).toEqual([2, 1]);
    expect(result.hasMore).toBe(false);
  });

  it('filters range using inclusive start and exclusive end', async () => {
    const result = await useCase([
      event(1, '2026-04-08T17:59:59'),
      event(2, '2026-04-08T18:00:00'),
      event(3, '2026-04-08T22:59:59'),
      event(4, '2026-04-08T23:00:00'),
    ]).between(new Date('2026-04-08T18:00:00'), new Date('2026-04-08T23:00:00'));

    expect(result.events.map((e) => e.id)).toEqual([3, 2]);
    expect(result.hasMore).toBe(false);
  });

  it('projects only the current verified private Drive link into browse results', async () => {
    const archive: ArchiveVerificationPort = {
      inspect: async (artifactId) => ({
        artifactId,
        cleanupSafe: false,
        webViewLink: 'https://drive.example/current-private-link',
        reason: 'local-changed',
      }),
    };
    const archived = event(1, '2026-04-08T18:00:00');
    archived.archiveArtifactId = 'artifact-1';
    archived.gdriveFileId = 'legacy-stale-path';

    const result = await useCase([archived], archive).latest();

    expect(result.events[0]).toMatchObject({
      archiveWebViewLink: 'https://drive.example/current-private-link',
    });
  });
});
