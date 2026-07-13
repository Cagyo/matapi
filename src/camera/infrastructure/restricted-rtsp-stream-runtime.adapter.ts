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
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  async start(input: Parameters<RtspStreamRuntimePort['start']>[0]): Promise<RtspStreamRuntimeHandle> {
    try {
      const loading = this.sources.loadForStream(input.cameraId);
      const loaded = input.deadlineMonotonicMs === undefined
        ? await loading
        : await beforeMonotonicDeadline(
            loading,
            input.deadlineMonotonicMs,
            this.monotonicNow,
          );
      if (!loaded) throw new Error('unavailable');
      return await this.coordinator.startRestrictedRuntime(loaded.source, input);
    } catch {
      throw new LiveSourceProbeFailedError();
    }
  }

  async recover(sessionId: string, deadlineMonotonicMs?: number): Promise<void> {
    if (deadlineMonotonicMs === undefined) {
      await this.coordinator.recoverRestrictedRuntime(sessionId);
    } else {
      await this.coordinator.recoverRestrictedRuntime(sessionId, deadlineMonotonicMs);
    }
  }
}

async function beforeMonotonicDeadline<T>(
  operation: Promise<T>,
  deadlineMonotonicMs: number,
  monotonicNow: () => number,
): Promise<T> {
  const remainingMs = deadlineMonotonicMs - monotonicNow();
  if (remainingMs <= 0) {
    void operation.catch(() => undefined);
    throw new Error('deadline');
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), remainingMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
