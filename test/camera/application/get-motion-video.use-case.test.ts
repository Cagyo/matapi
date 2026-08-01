import { describe, expect, it } from 'vitest';
import {
  GetMotionVideoUseCase,
  TELEGRAM_MAX_FILE_BYTES,
} from '../../../src/camera/application/get-motion-video.use-case';
import { EventNotFoundError } from '../../../src/camera/domain/errors/event-not-found.error';
import { MediaFileUnavailableError } from '../../../src/camera/domain/errors/media-file-unavailable.error';
import { MotionEvent } from '../../../src/camera/domain/motion-event.entity';
import { MediaFilePort } from '../../../src/camera/domain/ports/media-file.port';
import { InMemoryMediaRepository } from '../../../src/camera/infrastructure/in-memory-media.repository';
import type { ArchiveVerificationPort } from '../../../src/archive/application/ports/archive-verification.port';

function event(overrides: Partial<MotionEvent> = {}): MotionEvent {
  return {
    id: 1,
    cameraId: 'front_door',
    startedAt: new Date('2026-04-08T12:51:06Z'),
    endedAt: new Date('2026-04-08T12:51:36Z'),
    videoPath: '/var/lib/motion/1.mp4',
    snapshotPath: '/var/lib/motion/1.jpg',
    archiveArtifactId: null,
    uploadedToGdrive: false,
    gdriveFileId: null,
    localDeleted: false,
    ...overrides,
  };
}

function files(opts: { exists?: boolean; size?: number | null }): MediaFilePort {
  return {
    exists: async () => opts.exists ?? true,
    sizeBytes: async () => opts.size ?? 1024,
    mtimeMs: async () => null,
    localUsageBytes: async () => null,
  };
}

function makeUseCase(
  events: MotionEvent[],
  file: MediaFilePort,
  result: Awaited<ReturnType<ArchiveVerificationPort['inspect']>> | null = null,
): GetMotionVideoUseCase {
  const repo = new InMemoryMediaRepository();
  repo.seedEvents(events);
  const archive: ArchiveVerificationPort = {
    inspect: async (artifactId) => result ?? {
      artifactId,
      cleanupSafe: true,
      webViewLink: 'https://drive.example/current-private-link',
      reason: 'verified',
    },
  };
  return new GetMotionVideoUseCase(repo, file, archive);
}

describe('GetMotionVideoUseCase', () => {
  it('delivers the local file when present and within the size limit', async () => {
    const useCase = makeUseCase([event()], files({ exists: true, size: 1024 }));
    const delivery = await useCase.execute(1);
    expect(delivery.kind).toBe('local');
    if (delivery.kind === 'local') {
      expect(delivery.path).toBe('/var/lib/motion/1.mp4');
    }
  });

  it('falls back to Drive when the local file is too large and uploaded', async () => {
    const useCase = makeUseCase(
      [event({ archiveArtifactId: 'artifact-1', gdriveFileId: 'stale-path' })],
      files({ exists: true, size: TELEGRAM_MAX_FILE_BYTES + 1 }),
    );
    const delivery = await useCase.execute(1);
    expect(delivery).toMatchObject({
      kind: 'drive',
      webViewLink: 'https://drive.example/current-private-link',
    });
  });

  it('keeps local delivery for an oversized file with no Drive copy', async () => {
    const useCase = makeUseCase(
      [event({ gdriveFileId: null })],
      files({ exists: true, size: TELEGRAM_MAX_FILE_BYTES + 1 }),
    );
    const delivery = await useCase.execute(1);
    expect(delivery.kind).toBe('local');
  });

  it('delivers Drive when no local copy survives but it was uploaded', async () => {
    const useCase = makeUseCase(
      [event({ localDeleted: true, archiveArtifactId: 'artifact-1', gdriveFileId: 'stale-path' })],
      files({ exists: false }),
    );
    const delivery = await useCase.execute(1);
    expect(delivery).toMatchObject({
      kind: 'drive',
      webViewLink: 'https://drive.example/current-private-link',
    });
  });

  it('never falls back to a stale Drive path when current verification is unsafe', async () => {
    const useCase = makeUseCase(
      [event({ localDeleted: true, archiveArtifactId: 'artifact-1', gdriveFileId: 'stale-path' })],
      files({ exists: false }),
      {
        artifactId: 'artifact-1',
        cleanupSafe: false,
        webViewLink: null,
        reason: 'detached',
      },
    );

    await expect(useCase.execute(1)).rejects.toBeInstanceOf(MediaFileUnavailableError);
  });

  it('throws MediaFileUnavailableError when no copy exists anywhere', async () => {
    const useCase = makeUseCase(
      [event({ localDeleted: true, gdriveFileId: null })],
      files({ exists: false }),
    );
    await expect(useCase.execute(1)).rejects.toBeInstanceOf(MediaFileUnavailableError);
  });

  it('throws EventNotFoundError for an unknown event', async () => {
    const useCase = makeUseCase([], files({}));
    await expect(useCase.execute(99)).rejects.toBeInstanceOf(EventNotFoundError);
  });
});
