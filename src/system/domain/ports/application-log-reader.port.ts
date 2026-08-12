import type { ApplicationLogSnapshot, ApplicationLogStream } from '../application-log';

export const APPLICATION_LOG_READER = Symbol('APPLICATION_LOG_READER');

export interface ApplicationLogReadLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface ApplicationLogReaderPort {
  read(
    stream: ApplicationLogStream,
    limits: ApplicationLogReadLimits,
  ): Promise<ApplicationLogSnapshot>;
}
