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
import { LiveStreamSourceResolverService } from './live-stream-source-resolver.service';

export interface OpenLiveStreamInput {
  telegramId: number;
  cameraName?: string;
}

export interface OpenLiveStreamByIdInput {
  telegramId: number;
  cameraId: string;
}

/** Opens or joins the one shared Motion/RTSP live-stream session. */
@Injectable()
export class OpenLiveStreamUseCase {
  constructor(
    private readonly source: LiveStreamSourceResolverService,
    private readonly sessions: LiveStreamSessionService,
    @Inject(LIVE_STREAM_CAPABILITY)
    private readonly capability: LiveStreamCapabilityPort,
  ) {}

  async execute(input: OpenLiveStreamInput): Promise<OpenLiveStreamResult> {
    await this.ensureAvailable();
    return this.sessions.open(await this.source.resolve(input.cameraName), input.telegramId);
  }

  async executeById(input: OpenLiveStreamByIdInput): Promise<OpenLiveStreamResult> {
    await this.ensureAvailable();
    return this.sessions.open(await this.source.resolveById(input.cameraId), input.telegramId);
  }

  private async ensureAvailable(): Promise<void> {
    if (!(await this.capability.isAvailable())) {
      throw new LiveStreamUnavailableError();
    }
  }
}
