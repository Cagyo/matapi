import type {
  ApplicationLogSnapshot,
  ApplicationLogStream,
} from '../domain/application-log';
import type {
  ApplicationLogReaderPort,
  ApplicationLogReadLimits,
} from '../domain/ports/application-log-reader.port';

export class InMemoryApplicationLogReaderAdapter implements ApplicationLogReaderPort {
  readonly requests: {
    stream: ApplicationLogStream;
    limits: ApplicationLogReadLimits;
  }[] = [];

  constructor(
    private readonly snapshots: Partial<Record<ApplicationLogStream, ApplicationLogSnapshot>> = {},
    private readonly failure?: Error,
  ) {}

  async read(
    stream: ApplicationLogStream,
    limits: ApplicationLogReadLimits,
  ): Promise<ApplicationLogSnapshot> {
    this.requests.push({ stream, limits });
    if (this.failure) throw this.failure;
    return this.snapshots[stream] ?? { stream, lines: [], truncatedByByteLimit: false };
  }
}
