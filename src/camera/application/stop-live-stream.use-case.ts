import { Injectable } from '@nestjs/common';
import { LiveStreamSessionService } from './live-stream-session.service';

/** Stops the shared live stream for any registered user. */
@Injectable()
export class StopLiveStreamUseCase {
  constructor(private readonly sessions: LiveStreamSessionService) {}

  execute(telegramId: number): Promise<string | null> {
    return this.sessions.stop(telegramId);
  }
}
