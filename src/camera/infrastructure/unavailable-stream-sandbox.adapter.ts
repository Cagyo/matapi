import { StreamRuntimeUnavailableError } from '../domain/errors/stream-runtime-unavailable.error';
import type { StreamSandboxPort } from '../domain/ports/stream-sandbox.port';

export class UnavailableStreamSandboxAdapter implements StreamSandboxPort {
  async start(_input: Parameters<StreamSandboxPort['start']>[0]): Promise<never> {
    throw new StreamRuntimeUnavailableError();
  }

  async stop(_sessionId: string): Promise<never> {
    throw new StreamRuntimeUnavailableError();
  }
}
