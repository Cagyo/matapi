import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import {
  GdriveSyncHealthPort,
  GdriveSyncHealthSnapshot,
} from '../domain/ports/gdrive-sync-health.port';

const KEY_FAILURES = 'gdrive_sync_failures';
const KEY_LAST_ERROR = 'gdrive_sync_last_error';
const KEY_LAST_SUCCESS = 'gdrive_sync_last_success_at';

/**
 * `GdriveSyncHealthPort` persisted in `system_meta` so counters and the
 * last-success timestamp survive PM2 restarts. Reads stay in memory; writes
 * update memory first, then await one persistence attempt.
 */
@Injectable()
export class MetaGdriveSyncHealth
  implements GdriveSyncHealthPort, OnApplicationBootstrap
{
  private readonly logger = new Logger(MetaGdriveSyncHealth.name);
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSuccessAt: Date | null = null;

  constructor(
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const [failures, lastError, lastSuccess] = await Promise.all([
        this.meta.get(KEY_FAILURES),
        this.meta.get(KEY_LAST_ERROR),
        this.meta.get(KEY_LAST_SUCCESS),
      ]);
      const n = Number(failures);
      this.consecutiveFailures = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
      this.lastError = lastError || null;
      const ms = Number(lastSuccess);
      this.lastSuccessAt = Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
    } catch (err) {
      this.logger.warn(`Could not hydrate Drive sync health: ${(err as Error).message}`);
    }
  }

  snapshot(): GdriveSyncHealthSnapshot {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  async recordSuccess(at: Date): Promise<void> {
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSuccessAt = at;
    await this.persistSafely();
  }

  async recordFailure(error: string): Promise<void> {
    this.consecutiveFailures += 1;
    this.lastError = error;
    await this.persistSafely();
  }

  private async persistSafely(): Promise<void> {
    try {
      await this.persist();
    } catch (err) {
      this.logger.warn(`Could not persist Drive sync health: ${(err as Error).message}`);
    }
  }

  private async persist(): Promise<void> {
    await this.meta.set(KEY_FAILURES, String(this.consecutiveFailures));
    await this.meta.set(KEY_LAST_ERROR, this.lastError ?? '');
    await this.meta.set(
      KEY_LAST_SUCCESS,
      this.lastSuccessAt ? String(this.lastSuccessAt.getTime()) : '',
    );
  }
}
