import { Inject, Injectable } from '@nestjs/common';
import {
  RTSP_SOURCE_CONFIGURATION,
  type RtspSourceConfigurationPort,
} from '../domain/ports/rtsp-source-configuration.port';
import { RtspSourceMutationService } from './rtsp-source-mutation.service';
import type { TestRtspSourceInput } from './test-rtsp-source.use-case';

export interface RemoveRtspSourceInput extends TestRtspSourceInput {
  expectedRevision: number;
}

/**
 * Retires a source under the same compare-and-swap every edit uses, so a removal
 * decided from a stale listing loses rather than deleting a source the actor
 * never saw. Whether the camera row goes with it is the transaction's call, not
 * this use case's: only a camera minted to carry a source is removed outright.
 */
@Injectable()
export class RemoveRtspSourceUseCase {
  constructor(
    private readonly mutations: RtspSourceMutationService,
    @Inject(RTSP_SOURCE_CONFIGURATION)
    private readonly configuration: RtspSourceConfigurationPort,
  ) {}

  async execute(input: RemoveRtspSourceInput): Promise<{ removed: 'camera' | 'source' }> {
    return this.mutations.retire(
      {
        actorUserId: input.actorUserId,
        cameraId: input.cameraId,
        expectedRevision: input.expectedRevision,
      },
      () =>
        this.configuration.remove({
          cameraId: input.cameraId,
          expectedRevision: input.expectedRevision,
        }),
    );
  }
}
