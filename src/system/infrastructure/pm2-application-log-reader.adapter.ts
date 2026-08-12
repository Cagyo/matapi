import { execFile as nodeExecFile } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { ApplicationLogSnapshot, ApplicationLogStream } from '../domain/application-log';
import { ApplicationLogUnavailableError } from '../domain/errors/application-log-unavailable.error';
import type {
  ApplicationLogReaderPort,
  ApplicationLogReadLimits,
} from '../domain/ports/application-log-reader.port';
import { sanitizeAndBoundApplicationLogLines } from './application-log.mapper';
import { BoundedLogTailGateway } from './bounded-log-tail.gateway';

const PM2_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const PM2_METADATA_TIMEOUT_MS = 5_000;
const SANITIZED_SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

type ExecutePm2 = (
  executable: string,
  arguments_: readonly string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string>;
    timeout: number;
    maxBuffer: number;
    shell: false;
  },
) => Promise<{ stdout: string; stderr: string }>;

export interface Pm2ApplicationLogReaderDependencies {
  readonly executePm2?: ExecutePm2;
  readonly tail?: BoundedLogTailGateway;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface ApplicationLogPaths {
  readonly output: string;
  readonly error: string;
}

export class Pm2ApplicationLogReaderAdapter implements ApplicationLogReaderPort {
  private readonly executePm2: ExecutePm2;
  private readonly tail: BoundedLogTailGateway;
  private readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(dependencies: Pm2ApplicationLogReaderDependencies = {}) {
    this.executePm2 = dependencies.executePm2 ?? promisify(nodeExecFile);
    this.tail = dependencies.tail ?? new BoundedLogTailGateway();
    this.environment = dependencies.environment ?? process.env;
  }

  async read(
    stream: ApplicationLogStream,
    limits: ApplicationLogReadLimits,
  ): Promise<ApplicationLogSnapshot> {
    const paths = await this.resolvePaths();

    try {
      const raw = await this.tail.read({ path: paths[stream], ...limits });
      const sanitized = sanitizeAndBoundApplicationLogLines(
        raw.lines,
        this.environment,
        limits.maxBytes,
      );
      return {
        stream,
        lines: sanitized.lines,
        truncatedByByteLimit: raw.truncatedByByteLimit || sanitized.truncatedByByteLimit,
      };
    } catch (error) {
      if (error instanceof ApplicationLogUnavailableError) throw error;
      throw new ApplicationLogUnavailableError('file-unavailable');
    }
  }

  private async resolvePaths(): Promise<ApplicationLogPaths> {
    let stdout: string;

    try {
      ({ stdout } = await this.executePm2('pm2', ['jlist'], {
        encoding: 'utf8',
        env: this.childEnvironment(),
        timeout: PM2_METADATA_TIMEOUT_MS,
        maxBuffer: PM2_METADATA_MAX_BYTES,
        shell: false,
      }));
    } catch {
      throw new ApplicationLogUnavailableError('pm2-unavailable');
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(stdout) as unknown;
    } catch {
      throw new ApplicationLogUnavailableError('pm2-metadata-invalid');
    }
    if (!Array.isArray(metadata)) {
      throw new ApplicationLogUnavailableError('pm2-metadata-invalid');
    }

    const applicationName = this.environment.PM2_APP_NAME?.trim() || 'worker';
    const matches = metadata.filter(
      (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === applicationName,
    );
    if (matches.length === 0) {
      throw new ApplicationLogUnavailableError('process-not-found');
    }
    if (matches.length !== 1) {
      throw new ApplicationLogUnavailableError('process-ambiguous');
    }

    const environment = matches[0].pm2_env;
    if (!isRecord(environment)) {
      throw new ApplicationLogUnavailableError('stream-path-invalid');
    }

    const output = normalizeAbsolutePath(environment.pm_out_log_path);
    const error = normalizeAbsolutePath(environment.pm_err_log_path);
    if (output === error) {
      throw new ApplicationLogUnavailableError('stream-path-collision');
    }

    return { output, error };
  }

  private childEnvironment(): Record<string, string> {
    const environment: Record<string, string> = { PATH: SANITIZED_SYSTEM_PATH };
    if (this.environment.HOME) {
      environment.HOME = this.environment.HOME;
    }
    if (this.environment.PM2_HOME) {
      environment.PM2_HOME = this.environment.PM2_HOME;
    }
    return environment;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAbsolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new ApplicationLogUnavailableError('stream-path-invalid');
  }
  return normalize(value);
}
