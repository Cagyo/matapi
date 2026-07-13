import { LiveStreamSessionService } from './camera/application/live-stream-session.service';
import { GracefulShutdownService } from './system/application/graceful-shutdown.service';

export interface ApplicationShutdownContext {
  get(token: unknown): unknown;
}

/** Composition-root ordering while Telegram's message-cleanup seam is live. */
export async function prepareApplicationShutdown(
  app: ApplicationShutdownContext,
  signal: string,
): Promise<void> {
  const liveStreams = app.get(LiveStreamSessionService) as LiveStreamSessionService;
  const graceful = app.get(GracefulShutdownService) as GracefulShutdownService;
  await liveStreams.shutdown();
  await graceful.run(signal);
}
