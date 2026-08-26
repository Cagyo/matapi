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
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';

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
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
    private readonly gate?: RtspSourceStartGate,
  ) {}

  async execute(input: ConfigureLiveSourceInput): Promise<RedactedLiveSource> {
    await this.availability?.requireReady('rtsp');
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
    await this.availability?.requireReady('rtsp');
    this.gate?.assertCanStart('rtsp');
    await this.probe.run(source);
    const encrypted = this.credentials.encrypt(
      source.cameraId,
      source.credentialPayload(),
    );
    await this.availability?.requireReady('rtsp');
    this.gate?.assertCanStart('rtsp');
    await this.repository.save(source, encrypted);
    // The camera resolved above owns the display name; the read-back adds only
    // the stored version metadata, which this path never writes itself.
    const stored = await this.repository.findRedacted(source.cameraId);
    return {
      cameraId: source.cameraId,
      cameraName: camera.name,
      summary: source.summary(),
      hasCredential: true,
      revision: stored?.revision ?? 0,
      verifiedAt: stored?.verifiedAt ?? null,
      policyDigest: stored?.policyDigest ?? null,
    };
  }
}
