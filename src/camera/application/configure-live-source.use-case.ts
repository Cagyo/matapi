import { Inject, Injectable } from '@nestjs/common';
import { CameraNotFoundError } from '../domain/errors/camera-not-found.error';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import {
  LiveSource,
  type LiveSourceProfileSettings,
  type LiveSourceSecuritySettings,
  type LiveSourceTransportSettings,
} from '../domain/live-source.entity';
import {
  LIVE_SOURCE_CREDENTIAL,
  type LiveSourceCredentialPort,
} from '../domain/ports/live-source-credential.port';
import {
  LIVE_SOURCE_PROBE,
  type LiveSourceProbePort,
} from '../domain/ports/live-source-probe.port';
import {
  LIVE_SOURCE_REPOSITORY,
  type RedactedLiveSource,
  type LiveSourceRepositoryPort,
} from '../domain/ports/live-source-repository.port';
import {
  MEDIA_REPOSITORY,
  type MediaRepositoryPort,
} from '../domain/ports/media-repository.port';

export interface ConfigureLiveSourceInput {
  cameraName: string;
  url: string;
  transport: LiveSourceTransportSettings['transport'];
  tlsMode: LiveSourceSecuritySettings['tlsMode'];
  profile: LiveSourceProfileSettings['profile'];
  substream?: string | null;
}

@Injectable()
export class ConfigureLiveSourceUseCase {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    @Inject(LIVE_SOURCE_CREDENTIAL)
    private readonly credentials: LiveSourceCredentialPort,
    @Inject(LIVE_SOURCE_PROBE) private readonly probe: LiveSourceProbePort,
  ) {}

  async execute(input: ConfigureLiveSourceInput): Promise<RedactedLiveSource> {
    if ('certificateFingerprint' in input) {
      throw new InvalidLiveSourceError('certificate fingerprint is unsupported');
    }
    const camera = await this.media.findCameraByName(input.cameraName);
    if (!camera) throw new CameraNotFoundError(input.cameraName);
    const source = LiveSource.create({
      cameraId: camera.id,
      url: input.url,
      transport: input.transport,
      tlsMode: input.tlsMode,
      profile: input.profile,
      substream: input.substream,
      ready: true,
    });
    await this.probe.run(source);
    const encrypted = this.credentials.encrypt(
      source.cameraId,
      source.credentialPayload(),
    );
    await this.repository.save(source, encrypted);
    return {
      cameraId: source.cameraId,
      cameraName: camera.name,
      summary: source.summary(),
    };
  }
}
