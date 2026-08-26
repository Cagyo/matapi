import type { LiveStreamSource } from '../domain/live-stream.entity';
import type { LiveSourceSessionControlPort } from '../domain/ports/live-source-session-control.port';
import { LiveStreamSessionService } from '../application/live-stream-session.service';

/** Exposes the session state machine's scoped stops to source mutation flows. */
export class LiveStreamSessionControlAdapter
  implements LiveSourceSessionControlPort
{
  constructor(private readonly sessions: LiveStreamSessionService) {}

  async stopCamera(cameraId: string): Promise<void> {
    await this.sessions.stopCamera(cameraId);
  }

  async stopSourceKind(kind: LiveStreamSource['kind']): Promise<void> {
    await this.sessions.stopSourceKind(kind);
  }
}
