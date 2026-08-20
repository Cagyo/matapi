import { describe, expect, it, vi } from 'vitest';
import type { ArchiveArtifact } from '../../../src/archive/domain/archive-artifact.entity';
import { RegisterCompletedMotionVideosUseCase } from '../../../src/camera/application/register-completed-motion-videos.use-case';
import type {
  CompletedMotionVideoDescriptor,
  CompletedMotionVideoPort,
  CompletedMotionVideoScanCursor,
} from '../../../src/camera/domain/ports/completed-motion-video.port';

const descriptor: CompletedMotionVideoDescriptor = {
  kind: 'motion_video',
  sourceIdentity: 'motion:2026/07/29/120000-12345.mp4',
  trustedPath: '/motion/2026/07/29/120000-12345.mp4',
  relativePath: '2026/07/29/120000-12345.mp4',
  size: 42,
  mtimeNs: '1000000000',
  sourceTimeMs: 1_785_297_600_000,
  sha256: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
};

function event(id: number, videoPath = descriptor.trustedPath) {
  return {
    id,
    cameraId: 'front',
    startedAt: new Date(descriptor.sourceTimeMs),
    endedAt: new Date(descriptor.sourceTimeMs),
    videoPath,
    snapshotPath: null,
    archiveArtifactId: null,
    localDeleted: false,
  };
}

describe('RegisterCompletedMotionVideosUseCase', () => {
  it.each(['empty', 'symlink', 'outside-root', 'partial', 'unexpected-extension', 'unstable'])(
    'rejects %s candidates without registration',
    async (fixture) => {
      const completed = completedPort({ resolve: vi.fn().mockResolvedValue(null) });
      const repository = media([event(1)]);
      const archive = { register: vi.fn() };
      const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

      await useCase.executeForEvent(1);

      expect(archive.register).not.toHaveBeenCalled();
      expect(repository.deferArchiveRegistration).toHaveBeenCalledWith([1]);
      expect(fixture).toBeTruthy();
    },
  );

  it('restarts stabilization when the file changes during hashing', async () => {
    const completed = completedPort({ resolve: vi.fn().mockResolvedValue(null) });
    const repository = media([event(1)]);
    const archive = { register: vi.fn() };
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

    await useCase.executeForEvent(1);

    expect(archive.register).not.toHaveBeenCalled();
    expect(repository.deferArchiveRegistration).toHaveBeenCalledWith([1]);
  });

  it('maps several event rows for the same fingerprint to one artifact', async () => {
    const completed = completedPort({
      resolve: vi.fn().mockResolvedValue(descriptor),
      scanBatch: vi.fn().mockResolvedValue({ descriptors: [descriptor], cursor: null, complete: true, visitedEntries: 1 }),
    });
    const repository = media([event(1), event(2)]);
    const archive = { register: vi.fn().mockResolvedValue({ id: 'artifact-1' }) };
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

    await useCase.reconcileBatch(null);

    expect(archive.register).toHaveBeenCalledTimes(1);
    expect(repository.attachArchiveArtifact).toHaveBeenCalledWith([1, 2], 'artifact-1');
  });

  it('deduplicates different Motion paths with the same content fingerprint', async () => {
    const secondPath = '/motion/2026/07/29/120001-67890.mp4';
    const second = { ...descriptor, trustedPath: secondPath, relativePath: '2026/07/29/120001-67890.mp4' };
    const completed = completedPort({
      resolve: vi.fn(async (path: string) => path === secondPath ? second : descriptor),
    });
    const repository = media([event(1), event(2, secondPath)]);
    const archive = { register: vi.fn().mockResolvedValue({ id: 'artifact-1' }) };
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

    await useCase.reconcileBatch(null);

    expect(archive.register).toHaveBeenCalledTimes(1);
    expect(repository.attachArchiveArtifact).toHaveBeenCalledWith([1, 2], 'artifact-1');
  });

  it('converges after registration succeeded before attaching the event rows', async () => {
    const completed = completedPort({ resolve: vi.fn().mockResolvedValue(descriptor) });
    const repository = media([event(1)]);
    repository.attachArchiveArtifact.mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue(undefined);
    const artifact = { id: 'artifact-1' } as ArchiveArtifact;
    const archive = { register: vi.fn().mockResolvedValue(artifact) };
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

    await expect(useCase.executeForEvent(1)).rejects.toThrow('interrupted');
    await expect(useCase.executeForEvent(1)).resolves.toBeUndefined();

    expect(archive.register).toHaveBeenCalledTimes(2);
    expect(repository.attachArchiveArtifact).toHaveBeenLastCalledWith([1], artifact.id);
    expect(repository.createCompletedEvent).not.toHaveBeenCalled();
  });

  it('does not create a phantom event for an already referenced Motion path', async () => {
    const referenced = { ...event(9), archiveArtifactId: 'already-registered' };
    const completed = completedPort({
      resolve: vi.fn().mockResolvedValue(descriptor),
      scanBatch: vi.fn().mockResolvedValue({ descriptors: [descriptor], cursor: null, complete: true, visitedEntries: 1 }),
    });
    const repository = media([referenced]);
    const archive = { register: vi.fn() };
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

    await useCase.reconcileBatch(null);

    expect(repository.createCompletedEvent).not.toHaveBeenCalled();
    expect(archive.register).not.toHaveBeenCalled();
  });

  it('stops reconciliation at an abort checkpoint', async () => {
    const controller = new AbortController();
    const secondPath = '/motion/2026/07/29/120001-67890.mp4';
    const completed = completedPort({
      resolve: vi.fn(async () => {
        controller.abort(new DOMException('shutdown', 'AbortError'));
        return descriptor;
      }),
    });
    const repository = media([event(1), event(2, secondPath)]);
    const archive = { register: vi.fn() };
    const useCase = new RegisterCompletedMotionVideosUseCase(
      repository, completed, archive, 'install-1', repository,
    );

    await expect(useCase.reconcileBatch(null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(completed.resolve).toHaveBeenCalledOnce();
    expect(archive.register).not.toHaveBeenCalled();
  });

  it('forwards the explicit cursor and returns filesystem traversal progress', async () => {
    const cursor: CompletedMotionVideoScanCursor = {
      frames: [{ relativeDirectory: '2026/07', nextEntry: 12 }],
    };
    const next: CompletedMotionVideoScanCursor = {
      frames: [{ relativeDirectory: '2026/07', nextEntry: 64 }],
    };
    const completed = completedPort({
      scanBatch: vi.fn().mockResolvedValue({ descriptors: [], cursor: next, complete: false, visitedEntries: 64 }),
    });
    const repository = media([]);
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, { register: vi.fn() }, 'install-1', repository);

    await expect(useCase.reconcileBatch(cursor)).resolves.toEqual({ cursor: next, complete: false });
    expect(completed.scanBatch).toHaveBeenCalledWith({ cursor, entryLimit: 64 });
  });

  it('processes at most 64 durable completed events in one batch', async () => {
    const events = Array.from({ length: 70 }, (_, index) => event(index + 1, `/motion/${index}.mp4`));
    const repository = media(events);
    const completed = completedPort({ resolve: vi.fn().mockResolvedValue(null) });
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, { register: vi.fn() }, 'install-1', repository);

    await useCase.reconcileBatch(null);

    expect(completed.resolve).toHaveBeenCalledTimes(64);
    expect(repository.deferArchiveRegistration).toHaveBeenCalledTimes(64);
  });

  it('idempotently attaches unreferenced rows to the artifact already attached for a path', async () => {
    const referenced = { ...event(1), archiveArtifactId: 'artifact-1' };
    const repository = media([referenced, event(2)]);
    const archive = { register: vi.fn() };
    const completed = completedPort({ resolve: vi.fn().mockResolvedValue(descriptor) });
    const useCase = new RegisterCompletedMotionVideosUseCase(repository, completed, archive, 'install-1', repository);

    await useCase.reconcileBatch(null);

    expect(archive.register).not.toHaveBeenCalled();
    expect(repository.attachArchiveArtifact).toHaveBeenCalledWith([2], 'artifact-1');
    expect(repository.createCompletedEvent).not.toHaveBeenCalled();
  });
});

function completedPort(overrides: Partial<CompletedMotionVideoPort> = {}): CompletedMotionVideoPort {
  return {
    resolve: vi.fn().mockResolvedValue(null),
    scanBatch: vi.fn().mockResolvedValue({ descriptors: [], cursor: null, complete: true, visitedEntries: 0 }),
    ...overrides,
  };
}

function media(events: ReturnType<typeof event>[]) {
  return {
    findEventById: vi.fn(async (id: number) => events.find((current) => current.id === id) ?? null),
    findUnarchivedCompletedVideos: vi.fn(async (limit: number) => events.slice(0, limit)),
    findCompletedEventsByVideoPath: vi.fn(async (path: string) => events.filter((current) => current.videoPath === path)),
    findEventsByVideoPath: vi.fn(async (path: string) => events.filter((current) => current.videoPath === path)),
    createCompletedEvent: vi.fn(),
    attachArchiveArtifact: vi.fn(),
    deferArchiveRegistration: vi.fn(),
  };
}
