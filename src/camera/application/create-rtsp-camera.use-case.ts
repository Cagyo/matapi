import { Inject, Injectable } from '@nestjs/common';
import { cameraNameKey } from '../domain/camera-name-key';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import {
  CAMERA_ID_GENERATOR,
  type CameraIdGeneratorPort,
} from '../domain/ports/camera-id-generator.port';
import { liveSourceFrom } from '../domain/live-source-factory';
import type { RedactedLiveSource } from '../domain/ports/live-source-repository.port';
import {
  RTSP_SOURCE_CONFIGURATION,
  type RtspSourceConfigurationPort,
} from '../domain/ports/rtsp-source-configuration.port';
import {
  RtspSourceMutationService,
  type RtspSourceInput,
} from './rtsp-source-mutation.service';

/** Longest display name `cameras.name` and the Telegram prompts both accept. */
const MAX_DISPLAY_NAME_LENGTH = 64;

export interface CreateRtspCameraInput extends RtspSourceInput {
  displayName: string;
}

/**
 * Adds a camera that exists only to carry an RTSP source. The identifier is
 * minted by `CAMERA_ID_GENERATOR` and never derived from the display name, and
 * the camera is unpersisted until the source has been probed and encrypted:
 * a failed verification leaves no half-built camera behind.
 */
@Injectable()
export class CreateRtspCameraUseCase {
  constructor(
    private readonly mutations: RtspSourceMutationService,
    @Inject(RTSP_SOURCE_CONFIGURATION)
    private readonly configuration: RtspSourceConfigurationPort,
    @Inject(CAMERA_ID_GENERATOR) private readonly ids: CameraIdGeneratorPort,
  ) {}

  async execute(input: CreateRtspCameraInput): Promise<RedactedLiveSource> {
    this.mutations.requireAdmin(input.actorUserId);
    const name = displayName(input.displayName);
    const cameraId = this.ids.generate();
    const source = liveSourceFrom(cameraId, input);

    return this.mutations.install(
      {
        actorUserId: input.actorUserId,
        cameraId,
        source,
        expectedRevision: null,
        stopSessions: false,
      },
      (verified) =>
        this.configuration.createCamera({
          ...verified,
          camera: { id: cameraId, name, nameKey: cameraNameKey(name) },
        }),
    );
  }
}

/** The name is echoed back to the actor, so it is validated, never repaired. */
function displayName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new InvalidLiveSourceError('camera name is malformed');
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new InvalidLiveSourceError('camera name is malformed');
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new InvalidLiveSourceError('camera name is malformed');
    }
  }
  return trimmed;
}
