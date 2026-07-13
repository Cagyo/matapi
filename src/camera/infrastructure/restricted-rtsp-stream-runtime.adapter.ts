import { LiveSourceProbeFailedError } from '../domain/errors/live-source-probe-failed.error';
import type { LiveSourceRepositoryPort } from '../domain/ports/live-source-repository.port';
import type {
  RtspStreamRuntimeHandle,
  RtspStreamRuntimePort,
} from '../domain/ports/rtsp-stream-runtime.port';
import type { RtspRuntimeCoordinatorPort } from '../domain/ports/rtsp-runtime-coordinator.port';

/** Loads plaintext only at converter start, then delegates shared restricted orchestration. */
export class RestrictedRtspStreamRuntimeAdapter implements RtspStreamRuntimePort {
  constructor(
    private readonly sources: LiveSourceRepositoryPort,
    private readonly coordinator: RtspRuntimeCoordinatorPort,
  ) {}

  async start(input: Parameters<RtspStreamRuntimePort['start']>[0]): Promise<RtspStreamRuntimeHandle> {
    try {
      const loaded = await this.sources.loadForStream(input.cameraId);
      if (!loaded) throw new Error('unavailable');
      return await this.coordinator.startRestrictedRuntime(loaded.source, input);
    } catch {
      throw new LiveSourceProbeFailedError();
    }
  }

  async recover(sessionId: string): Promise<void> {
    await this.coordinator.recoverRestrictedRuntime(sessionId);
  }
}
