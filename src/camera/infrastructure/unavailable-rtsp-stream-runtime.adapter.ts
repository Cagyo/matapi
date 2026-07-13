import { StreamRuntimeUnavailableError } from '../domain/errors/stream-runtime-unavailable.error';
import type { RtspStreamRuntimePort } from '../domain/ports/rtsp-stream-runtime.port';

export class UnavailableRtspStreamRuntimeAdapter implements RtspStreamRuntimePort {
  async start(_input: Parameters<RtspStreamRuntimePort['start']>[0]): Promise<never> {
    throw new StreamRuntimeUnavailableError();
  }
  recover(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }
}
