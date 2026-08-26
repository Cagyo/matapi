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
   * Asserts both halves of the fence: that no `close()` has landed since
   * `expected` was taken, and that RTSP is open right now. The state check is
   * not redundant — a snapshot taken while the gate is already closed never
   * sees the epoch move, which is reachable at boot and permanently if the
   * bootstrap `open()` never completes.
   *
   * Throws `LiveStreamUnavailableError` for both halves: only `close()` moves
   * the epoch, so a stale token reports the same condition `assertCanStart`
   * does — RTSP went away — merely observed across an await boundary.
   */
  assertEpoch(expected: number): void {
    if (expected !== this.epoch || this.rtspClosed) {
      throw new LiveStreamUnavailableError();
    }
  }

  assertCanStart(kind: LiveStreamSource['kind']): void {
    if (kind === 'rtsp' && this.rtspClosed) {
      throw new LiveStreamUnavailableError();
    }
  }
}
