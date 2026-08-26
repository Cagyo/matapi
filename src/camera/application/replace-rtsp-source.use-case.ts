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

export interface ReplaceRtspSourceInput extends RtspSourceInput {
  cameraId: string;
  expectedRevision: number;
}

/**
 * Swaps a stored source for a newly verified one. Only this camera's live-stream
 * work is stopped, and only after the replacement has passed its probe — so a
 * doomed edit never takes a working camera off air. A lost compare-and-swap
 * leaves the old source and credential authoritative; the stopped session stays
 * stopped rather than being resurrected against a source that may be gone.
 */
@Injectable()
export class ReplaceRtspSourceUseCase {
  constructor(
    private readonly mutations: RtspSourceMutationService,
    @Inject(RTSP_SOURCE_CONFIGURATION)
    private readonly configuration: RtspSourceConfigurationPort,
  ) {}

  async execute(input: ReplaceRtspSourceInput): Promise<RedactedLiveSource> {
    const source = liveSourceFrom(input.cameraId, input);

    return this.mutations.install(
      {
        actorUserId: input.actorUserId,
        cameraId: input.cameraId,
        source,
        expectedRevision: input.expectedRevision,
        stopSessions: true,
      },
      (verified) =>
        this.configuration.replace({
          ...verified,
          cameraId: input.cameraId,
          expectedRevision: input.expectedRevision,
        }),
    );
  }
}
