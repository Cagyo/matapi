export const LIVE_SOURCE_SESSION_CONTROL = Symbol('LIVE_SOURCE_SESSION_CONTROL');

export interface LiveSourceSessionControlPort {
  /** Stops the one global active/pending live-stream session, if any. */
  stopActiveSession(): Promise<void>;
}
