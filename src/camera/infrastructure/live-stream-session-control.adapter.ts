import type { LiveSourceSessionControlPort } from '../domain/ports/live-source-session-control.port';
import { LiveStreamSessionService } from '../application/live-stream-session.service';

/** Safely stops the single global session before source metadata is removed. */
export class LiveStreamSessionControlAdapter
  implements LiveSourceSessionControlPort
{
  constructor(private readonly sessions: LiveStreamSessionService) {}

  async stopActiveSession(): Promise<void> {
    await this.sessions.stop(0);
  }
}
