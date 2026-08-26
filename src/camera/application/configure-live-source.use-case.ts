import { Inject, Injectable } from '@nestjs/common';
import { CameraNotFoundError } from '../domain/errors/camera-not-found.error';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import type {
  LiveSourceProfileSettings,
  LiveSourceSecuritySettings,
  LiveSourceTransportSettings,
} from '../domain/live-source.entity';
import {
  LIVE_SOURCE_REPOSITORY,
  type RedactedLiveSource,
  type LiveSourceRepositoryPort,
} from '../domain/ports/live-source-repository.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';
import { AttachRtspSourceUseCase } from './attach-rtsp-source.use-case';
import { ReplaceRtspSourceUseCase } from './replace-rtsp-source.use-case';

export interface ConfigureLiveSourceInput {
  actorUserId: number;
  cameraName: string;
  url: string;
  transport: LiveSourceTransportSettings['transport'];
  tlsMode: LiveSourceSecuritySettings['tlsMode'];
  profile: LiveSourceProfileSettings['profile'];
  substream?: string | null;
}

/**
 * Temporary compatibility wrapper for the name-addressed flow the Telegram
 * source menu still speaks. It owns no persistence of its own: it resolves the
 * display name to a camera and then delegates to the fenced operations, picking
 * attach for a camera with no stored source and replace for one that has any —
 * including the credential-free metadata a config import leaves behind.
 *
 * Retired once the source workflow addresses cameras by identifier and carries
 * its own revision.
 */
@Injectable()
export class ConfigureLiveSourceUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    private readonly attach: AttachRtspSourceUseCase,
    private readonly replace: ReplaceRtspSourceUseCase,
  ) {}

  async execute(input: ConfigureLiveSourceInput): Promise<RedactedLiveSource> {
    if ('certificateFingerprint' in input) {
      throw new InvalidLiveSourceError('certificate fingerprint is unsupported');
    }
    const camera = await this.media.findCameraByName(input.cameraName);
    if (!camera) throw new CameraNotFoundError(input.cameraName);
    const stored = await this.repository.findRedacted(camera.id);
    const source = {
      actorUserId: input.actorUserId,
      url: input.url,
      transport: input.transport,
      tlsMode: input.tlsMode,
      profile: input.profile,
      substream: input.substream,
    };

    return stored === null
      ? this.attach.execute({ ...source, cameraId: camera.id })
      : this.replace.execute({
          ...source,
          cameraId: camera.id,
          expectedRevision: stored.revision,
        });
  }
}
