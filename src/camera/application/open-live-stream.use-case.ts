import { Inject, Injectable } from '@nestjs/common';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import {
  LIVE_STREAM_CAPABILITY,
  type LiveStreamCapabilityPort,
} from '../domain/ports/live-stream-capability.port';
import {
  LiveStreamSessionService,
  type OpenLiveStreamResult,
} from './live-stream-session.service';
import { MotionLiveSourceService } from './motion-live-source.service';

export interface OpenLiveStreamInput {
  telegramId: number;
  cameraName?: string;
}

/** Opens (or joins) the one shared Motion live-stream session. */
@Injectable()
export class OpenLiveStreamUseCase {
  constructor(
    private readonly source: MotionLiveSourceService,
    private readonly sessions: LiveStreamSessionService,
    @Inject(LIVE_STREAM_CAPABILITY)
    private readonly capability: LiveStreamCapabilityPort,
  ) {}

  async execute(input: OpenLiveStreamInput): Promise<OpenLiveStreamResult> {
    if (!(await this.capability.isAvailable())) {
      throw new LiveStreamUnavailableError();
    }
    return this.sessions.open(await this.source.resolve(input.cameraName), input.telegramId);
  }
}
