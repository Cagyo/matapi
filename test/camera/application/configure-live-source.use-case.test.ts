import { describe, expect, it, vi } from 'vitest';
import type { AttachRtspSourceUseCase } from '../../../src/camera/application/attach-rtsp-source.use-case';
import { ConfigureLiveSourceUseCase } from '../../../src/camera/application/configure-live-source.use-case';
import type { ReplaceRtspSourceUseCase } from '../../../src/camera/application/replace-rtsp-source.use-case';
import { CameraNotFoundError } from '../../../src/camera/domain/errors/camera-not-found.error';
import type {
  LiveSourceRepositoryPort,
  RedactedLiveSource,
} from '../../../src/camera/domain/ports/live-source-repository.port';
import type { MediaRepositoryPort } from '../../../src/camera/domain/ports/media-repository.port';

const camera = {
  id: 'camera-1',
  name: 'front_door',
  type: 'motion',
  config: null,
  enabled: true,
};

const stored: RedactedLiveSource = {
  cameraId: 'camera-1',
  cameraName: 'front_door',
  summary: {
    scheme: 'rtsp',
    host: 'cam.local',
    transport: 'tcp',
    tlsMode: 'none',
    profile: 'eco',
    substreamHost: null,
    ready: true,
  },
  hasCredential: true,
  revision: 3,
  verifiedAt: null,
  policyDigest: null,
};

const request = {
  actorUserId: 7,
  cameraName: 'front_door',
  url: 'rtsp://user:pass@cam.local/private?token=secret',
  transport: 'tcp',
  tlsMode: 'none',
  profile: 'eco',
} as const;

function fixture(existing: RedactedLiveSource | null) {
  const media = {
    findCameraByName: vi.fn().mockResolvedValue(camera),
  } as unknown as MediaRepositoryPort;
  const repository = {
    findRedacted: vi.fn().mockResolvedValue(existing),
    save: vi.fn(),
    saveMetadataBatch: vi.fn(),
  } as unknown as LiveSourceRepositoryPort;
  const attach = { execute: vi.fn().mockResolvedValue(stored) } as unknown as AttachRtspSourceUseCase;
  const replace = { execute: vi.fn().mockResolvedValue(stored) } as unknown as ReplaceRtspSourceUseCase;
  return {
    attach,
    media,
    replace,
    repository,
    useCase: new ConfigureLiveSourceUseCase(media, repository, attach, replace),
  };
}

describe('ConfigureLiveSourceUseCase', () => {
  it('attaches when the resolved camera has no stored source', async () => {
    const { useCase, attach, replace, repository } = fixture(null);

    await expect(useCase.execute({ ...request })).resolves.toBe(stored);

    expect(attach.execute).toHaveBeenCalledWith({
      actorUserId: 7,
      cameraId: 'camera-1',
      url: request.url,
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
      substream: undefined,
    });
    expect(replace.execute).not.toHaveBeenCalled();
    // The wrapper owns no persistence path of its own.
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.saveMetadataBatch).not.toHaveBeenCalled();
  });

  it('replaces against the stored revision when a source already exists', async () => {
    const { useCase, attach, replace, repository } = fixture(stored);

    await useCase.execute({ ...request });

    expect(replace.execute).toHaveBeenCalledWith(
      expect.objectContaining({ cameraId: 'camera-1', expectedRevision: 3, actorUserId: 7 }),
    );
    expect(attach.execute).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown camera and a compatibility fingerprint without delegating', async () => {
    const { useCase, attach, replace, media } = fixture(null);
    vi.mocked(media.findCameraByName).mockResolvedValueOnce(null);

    await expect(useCase.execute({ ...request })).rejects.toBeInstanceOf(CameraNotFoundError);

    await expect(
      useCase.execute({ ...request, certificateFingerprint: 'sha256:legacy' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_LIVE_SOURCE' });
    expect(attach.execute).not.toHaveBeenCalled();
    expect(replace.execute).not.toHaveBeenCalled();
  });
});
