import { Injectable } from '@nestjs/common';
import { LocalFileInfo, LocalStoragePort } from '../domain/ports/local-storage.port';

/**
 * Dev/test `LocalStoragePort`. Reports the disk comfortably below every
 * cleanup threshold so the cleanup loop is a no-op on a dev box. The reported
 * percent is overridable for tests via `setUsagePercent`.
 */
@Injectable()
export class StubLocalStorageAdapter implements LocalStoragePort {
  private usage = 10;

  setUsagePercent(percent: number): void {
    this.usage = percent;
  }

  async usagePercent(): Promise<number> {
    return this.usage;
  }

  async deleteFile(): Promise<boolean> {
    return true;
  }

  async pruneEmptyDirs(): Promise<void> {
    // no-op
  }

  async listFilesOlderThan(): Promise<LocalFileInfo[]> {
    return [];
  }
}
