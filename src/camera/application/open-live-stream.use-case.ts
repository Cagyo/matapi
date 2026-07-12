import { Injectable } from '@nestjs/common';
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
  ) {}

  async execute(input: OpenLiveStreamInput): Promise<OpenLiveStreamResult> {
    return this.sessions.open(await this.source.resolve(input.cameraName), input.telegramId);
  }
}
