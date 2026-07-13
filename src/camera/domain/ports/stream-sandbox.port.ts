import type { LiveSourceProfileSettings } from '../live-source.entity';
import type { LiveSourceForStream } from './live-source-repository.port';

export const STREAM_SANDBOX = Symbol('STREAM_SANDBOX');

export interface UnixSocketStreamOutput {
  kind: 'unix-socket';
  socketPath: string;
  queueCapacityFrames: 2;
}

export interface StreamSandboxStartResult {
  processIdentity: string;
  health: { ready: boolean };
  output: UnixSocketStreamOutput;
}

export interface StreamSandboxPort {
  start(input: {
    sessionId: string;
    source: LiveSourceForStream;
    profile: LiveSourceProfileSettings['profile'];
    expiresAtUnixMs: number;
  }): Promise<StreamSandboxStartResult>;
  stop(sessionId: string): Promise<void>;
}
