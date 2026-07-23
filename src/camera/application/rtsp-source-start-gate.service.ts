import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import type { LiveStreamSource } from '../domain/live-stream.entity';
import { FEATURE_AVAILABILITY, type FeatureAvailabilityPort } from '../../features/domain/ports/feature-availability.port';
import { Inject } from '@nestjs/common';

/** Process-local, fail-closed gate for new RTSP converter starts. */
@Injectable()
export class RtspSourceStartGate implements OnApplicationBootstrap {
  private rtspClosed = true;
  private epoch = 0;

  constructor(
    @Inject(FEATURE_AVAILABILITY) private readonly availability?: FeatureAvailabilityPort,
    initiallyOpen = false,
  ) { this.rtspClosed = !initiallyOpen; }

  onApplicationBootstrap(): void { void this.open().catch(() => undefined); }

  close(): void {
    this.rtspClosed = true;
    this.epoch++;
  }

  async open(): Promise<void> {
    const epoch = this.epoch;
    await this.availability?.requireReady('rtsp');
    if (epoch !== this.epoch) return;
    this.rtspClosed = false;
  }

  isOpen(): boolean { return !this.rtspClosed; }

  assertCanStart(kind: LiveStreamSource['kind']): void {
    if (kind === 'rtsp' && this.rtspClosed) {
      throw new LiveStreamUnavailableError();
    }
  }
}
