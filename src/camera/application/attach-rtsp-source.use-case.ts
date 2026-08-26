import { Inject, Injectable } from '@nestjs/common';
import type { RedactedLiveSource } from '../domain/ports/live-source-repository.port';
import {
  RTSP_SOURCE_CONFIGURATION,
  type RtspSourceConfigurationPort,
} from '../domain/ports/rtsp-source-configuration.port';
import {
  liveSourceFrom,
  RtspSourceMutationService,
  type RtspSourceInput,
} from './rtsp-source-mutation.service';

export interface AttachRtspSourceInput extends RtspSourceInput {
  cameraId: string;
}

/**
 * Gives a camera that already exists — a Motion camera, or one restored from a
 * config import — its first RTSP source.
 *
 * That the camera is still enabled and still has no source is settled inside
 * the configuration transaction, not here: an answer read on this side of the
 * fence would be one `await` old by the time the swap ran.
 */
@Injectable()
export class AttachRtspSourceUseCase {
  constructor(
    private readonly mutations: RtspSourceMutationService,
    @Inject(RTSP_SOURCE_CONFIGURATION)
    private readonly configuration: RtspSourceConfigurationPort,
  ) {}

  async execute(input: AttachRtspSourceInput): Promise<RedactedLiveSource> {
    const source = liveSourceFrom(input.cameraId, input);

    return this.mutations.install(
      {
        actorUserId: input.actorUserId,
        cameraId: input.cameraId,
        source,
        expectedRevision: null,
        stopSessions: false,
      },
      (verified) => this.configuration.attach({ ...verified, cameraId: input.cameraId }),
    );
  }
}
