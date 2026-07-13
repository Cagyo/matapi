import { Injectable } from '@nestjs/common';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import type { LiveStreamSource } from '../domain/live-stream.entity';

/** Process-local, fail-closed gate for new RTSP converter starts. */
@Injectable()
export class RtspSourceStartGate {
  private rtspClosed = false;

  close(): void {
    this.rtspClosed = true;
  }

  assertCanStart(kind: LiveStreamSource['kind']): void {
    if (kind === 'rtsp' && this.rtspClosed) {
      throw new LiveStreamUnavailableError();
    }
  }
}
