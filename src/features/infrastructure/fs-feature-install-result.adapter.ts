import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isManageableFeature, parseFeatureInstallRequest, parseFeatureInstallResult, type FeatureInstallResultV1, type ManageableFeatureName } from '../domain/manageable-feature';
import type { FeatureInstallResultPort } from '../domain/ports/feature-install-result.port';
import { openNoFollow, readBounded, validateSpoolDirectory } from './fs-feature-install-request.adapter';

const DEFAULT_RESULT_DIRECTORY = '/var/lib/home-worker/feature-install-results';

export class FsFeatureInstallResultAdapter implements FeatureInstallResultPort {
  async readState(jobId: string, feature: ManageableFeatureName): Promise<
    | { kind: 'absent' } | { kind: 'running' } | { kind: 'terminal'; result: FeatureInstallResultV1 }
  > {
    if (!/^[A-Za-z0-9_-]{16}$/u.test(jobId) || !isManageableFeature(feature)) throw new RangeError('result-invalid');
    await validateSpoolDirectory(DEFAULT_RESULT_DIRECTORY, 0, process.getgid?.() ?? -1, 0o770)
      .catch(() => { throw new RangeError('result-invalid'); });
    // A durable marker is a commit barrier: do not observe an early result.
    const marker = await this.readMarker(join(DEFAULT_RESULT_DIRECTORY, `${jobId}.running`), jobId, feature);
    if (marker === 'absent') return this.readTerminal(join(DEFAULT_RESULT_DIRECTORY, `${jobId}.json`), jobId, feature);
    return { kind: 'running' };
  }

  async removeTerminal(jobId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16}$/u.test(jobId)) throw new RangeError('result-invalid');
    await validateSpoolDirectory(DEFAULT_RESULT_DIRECTORY, 0, process.getgid?.() ?? -1, 0o770)
      .catch(() => { throw new RangeError('result-invalid'); });
    const path = join(DEFAULT_RESULT_DIRECTORY, `${jobId}.json`);
    // Validate the exact terminal entry before deleting it after Task 8 commits.
    await this.readTerminal(path, jobId, undefined);
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  private async readMarker(path: string, jobId: string, feature: ManageableFeatureName): Promise<'present' | 'absent'> {
    try {
      const raw = await this.readSafe(path);
      const request = parseFeatureInstallRequest(raw);
      if (request.jobId !== jobId || request.feature !== feature) throw new RangeError('result-invalid');
      return 'present';
    } catch (error: unknown) {
      if (isCode(error, 'ENOENT')) return 'absent';
      throw normalize(error);
    }
  }

  private async readTerminal(path: string, jobId: string, feature?: ManageableFeatureName): Promise<{ kind: 'absent' } | { kind: 'terminal'; result: FeatureInstallResultV1 }> {
    try {
      const result = parseFeatureInstallResult(await this.readSafe(path));
      if (result.jobId !== jobId || (feature !== undefined && result.feature !== feature)) throw new RangeError('result-invalid');
      return { kind: 'terminal', result };
    } catch (error: unknown) {
      if (isCode(error, 'ENOENT')) return { kind: 'absent' };
      throw normalize(error);
    }
  }

  private async readSafe(path: string): Promise<string> {
    const handle = await openNoFollow(path);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== (process.getgid?.() ?? -1) || (stat.mode & 0o777) !== 0o640 || stat.size < 1 || stat.size > 4_096) {
        throw new RangeError('result-invalid');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(handle, stat.size));
    } finally { await handle.close(); }
  }
}

function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
function normalize(error: unknown): RangeError { return error instanceof RangeError && error.message === 'result-invalid' ? error : new RangeError('result-invalid'); }
