import type { ManageableFeatureName } from '../../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import { Logger } from '@nestjs/common';
import { defaultExecFile, hasGroups, modeOf, nodeReadinessFiles, READINESS_COMMAND_OPTIONS, type FileStat, type FixedExecFile } from './readiness-seams';

interface RtspFiles { stat(path: string): Promise<FileStat>; }
export interface RtspReadinessDependencies { execFile?: FixedExecFile; files?: RtspFiles; }

const ROOT_FILES: readonly (readonly [string, number])[] = [
  ['/usr/lib/home-worker/live-stream-net-helper', 0o755],
  ['/usr/lib/home-worker/live-stream-ffmpeg-runner', 0o755],
  ['/etc/systemd/system/homeworker-stream-net.service', 0o644],
  ['/etc/systemd/system/homeworker-ffmpeg-stream@.service', 0o644],
  ['/etc/polkit-1/rules.d/49-homeworker-stream-systemd.rules', 0o644],
  ['/etc/tmpfiles.d/homeworker-stream.conf', 0o644],
  ['/etc/home-worker/live-stream-policy.json', 0o600],
];
const RUNTIME_DIRECTORIES: readonly (readonly [string, number])[] = [
  ['/run/home-worker', 0o750],
  ['/run/home-worker/live-stream-config', 0o2730],
  ['/run/home-worker/live-stream-output', 0o3770],
];

export class RtspReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(RtspReadinessAdapter.name);
  private readonly execFile: FixedExecFile;
  private readonly files: RtspFiles;
  constructor(dependencies: RtspReadinessDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
    this.files = dependencies.files ?? nodeReadinessFiles;
  }

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    let check = 'ffmpeg executable';
    try {
      await this.execFile('/usr/bin/which', ['ffmpeg'], READINESS_COMMAND_OPTIONS);
      check = 'cloudflared executable';
      await this.execFile('/usr/bin/which', ['cloudflared'], READINESS_COMMAND_OPTIONS);
      check = 'root runtime artifacts';
      await this.assertRootFiles(ROOT_FILES, false, 0);
      check = 'stream group';
      const streamGroup = await this.execFile('/usr/bin/getent', ['group', 'homeworker-stream'], READINESS_COMMAND_OPTIONS);
      const streamGroupId = groupId(streamGroup.stdout, 'homeworker-stream');
      if (streamGroupId === null) throw new Error('stream group unresolved');
      check = 'runtime directories';
      await this.assertRootFiles(RUNTIME_DIRECTORIES, true, streamGroupId);
      check = 'worker groups';
      const groups = await this.execFile('/usr/bin/id', ['-nG'], READINESS_COMMAND_OPTIONS);
      if (!hasGroups(groups.stdout, ['homeworker-stream'])) throw new Error('worker group incomplete');
      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: rtsp ${check}`);
      return { ready: false, failureCode: 'application-verification-failed' };
    }
  }

  private async assertRootFiles(entries: readonly (readonly [string, number])[], directories: boolean, expectedGid: number): Promise<void> {
    for (const [path, expectedMode] of entries) {
      const file = await this.files.stat(path);
      if (file.uid !== 0 || file.gid !== expectedGid || modeOf(file) !== expectedMode || file.isDirectory() !== directories) throw new Error('runtime ownership or mode mismatch');
    }
  }
}

function groupId(output: string, name: string): number | null {
  const match = new RegExp(`^${name}:[^:\\r\\n]*:(\\d+):[^\\r\\n]*$`, 'm').exec(output.trim());
  if (!match) return null;
  const gid = Number(match[1]);
  return Number.isSafeInteger(gid) && gid >= 0 ? gid : null;
}
