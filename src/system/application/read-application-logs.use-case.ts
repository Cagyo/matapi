import { Inject, Injectable } from '@nestjs/common';
import {
  APPLICATION_LOG_MAX_BYTES,
  APPLICATION_LOG_MAX_LINES,
  type ApplicationLogSnapshot,
  type ApplicationLogStream,
} from '../domain/application-log';
import {
  APPLICATION_LOG_READER,
  type ApplicationLogReaderPort,
} from '../domain/ports/application-log-reader.port';

@Injectable()
export class ReadApplicationLogsUseCase {
  constructor(
    @Inject(APPLICATION_LOG_READER) private readonly reader: ApplicationLogReaderPort,
  ) {}

  execute(stream: ApplicationLogStream): Promise<ApplicationLogSnapshot> {
    return this.reader.read(stream, {
      maxLines: APPLICATION_LOG_MAX_LINES,
      maxBytes: APPLICATION_LOG_MAX_BYTES,
    });
  }
}
