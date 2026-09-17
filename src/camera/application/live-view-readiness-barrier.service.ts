import { Inject, Injectable } from '@nestjs/common';
import { LiveViewStartGate } from './live-view-start-gate.service';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';

/** Recovery alone completes this one process-wide boot prerequisite. */
@Injectable()
export class LiveViewReadinessBarrierService {
  private complete!: () => void;
  private readonly ready = new Promise<void>((resolve) => { this.complete = resolve; });

  constructor(
    @Inject(LiveViewStartGate) private readonly gate: LiveViewStartGate,
    @Inject(RtspSourceStartGate) private readonly rtsp: RtspSourceStartGate,
  ) {}

  wait(): Promise<void> { return this.ready; }
  markReady(): void { this.complete(); }
  markFailedClosed(): void {
    this.gate.close();
    this.rtsp.close();
    this.complete();
  }
}
