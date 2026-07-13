export const RTSP_STREAM_RUNTIME = Symbol('RTSP_STREAM_RUNTIME');

export interface RtspStreamRuntimeHandle {
  processIdentity: string;
  stop(): Promise<void>;
}

/** Restricted RTSP converter lifecycle. Inputs and outputs are secret-free. */
export interface RtspStreamRuntimePort {
  start(input: {
    cameraId: string;
    sessionId: string;
    socketPath: string;
    expiresAtUnixMs: number;
  }): Promise<RtspStreamRuntimeHandle>;
  recover(sessionId: string): Promise<void>;
}
