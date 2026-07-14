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
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';
import type { LiveStreamSource } from '../domain/live-stream.entity';

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
    private readonly sourceStartGate: RtspSourceStartGate,
  ) {}

  async execute(input: OpenLiveStreamInput): Promise<OpenLiveStreamResult> {
    const source = await this.source.resolve(input.cameraName);
    await this.ensureAvailable(source);
    return this.sessions.open(source, input.telegramId);
  }

  async executeById(input: OpenLiveStreamByIdInput): Promise<OpenLiveStreamResult> {
    const source = await this.source.resolveById(input.cameraId);
    await this.ensureAvailable(source);
    return this.sessions.open(source, input.telegramId);
  }

  private async ensureAvailable(source: LiveStreamSource): Promise<void> {
    this.sourceStartGate.assertCanStart(source.kind);
    if (!(await this.capability.isAvailable(source.kind))) {
      throw new LiveStreamUnavailableError();
    }
  }
}
