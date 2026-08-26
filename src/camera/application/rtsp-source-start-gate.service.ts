import { Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common';
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
    @Optional() initiallyOpen = false,
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

  /**
   * Fence token for a multi-step RTSP mutation. Take it before any await and
   * re-assert it immediately before the commit; a `close()` in between makes
   * the assertion fail, so the mutation aborts with no writes.
   */
  snapshot(): number { return this.epoch; }

  /**
   * Rejects a mutation whose fence token predates an RTSP close. Only
   * `close()` moves the epoch, so a stale token means the same condition
   * `assertCanStart` reports — RTSP went away — merely observed across an
   * await boundary. Reusing `LiveStreamUnavailableError` therefore keeps one
   * error at the interface boundary instead of splitting one condition in two.
   */
  assertEpoch(expected: number): void {
    if (expected !== this.epoch) {
      throw new LiveStreamUnavailableError();
    }
  }

  assertCanStart(kind: LiveStreamSource['kind']): void {
    if (kind === 'rtsp' && this.rtspClosed) {
      throw new LiveStreamUnavailableError();
    }
  }
}
