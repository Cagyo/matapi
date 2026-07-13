import type { LiveSource } from '../live-source.entity';
import type { RtspStreamRuntimeHandle } from './rtsp-stream-runtime.port';

export const RTSP_RUNTIME_COORDINATOR = Symbol('RTSP_RUNTIME_COORDINATOR');

export interface RtspRuntimeCoordinatorPort {
  startRestrictedRuntime(
    source: LiveSource,
    input: {
      sessionId: string;
      socketPath: string;
      expiresAtUnixMs: number;
      deadlineMonotonicMs?: number;
    },
  ): Promise<RtspStreamRuntimeHandle>;
  recoverRestrictedRuntime(sessionId: string, deadlineMonotonicMs?: number): Promise<void>;
}
