export const APPLICATION_LOG_MAX_LINES = 200;
export const APPLICATION_LOG_MAX_BYTES = 2 * 1024 * 1024;

export type ApplicationLogStream = 'output' | 'error';

export interface ApplicationLogSnapshot {
  readonly stream: ApplicationLogStream;
  readonly lines: readonly string[];
  readonly truncatedByByteLimit: boolean;
}
