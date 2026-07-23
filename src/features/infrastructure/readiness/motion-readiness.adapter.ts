import type { ManageableFeatureName } from '../../domain/manageable-feature';
import type { FeatureReadinessPort, FeatureReadinessResult } from '../../domain/ports/feature-readiness.port';
import { Logger } from '@nestjs/common';
import { defaultExecFile, hasGroups, nodeReadinessFiles, READINESS_COMMAND_OPTIONS, READINESS_MEDIA_DIRECTORY_ACCESS, type FixedExecFile } from './readiness-seams';

interface MotionFiles { readFile(path: string): Promise<string>; access(path: string, mode: number): Promise<void>; }
export interface MotionReadinessDependencies { execFile?: FixedExecFile; files?: MotionFiles; }

export class MotionReadinessAdapter implements FeatureReadinessPort {
  private readonly logger = new Logger(MotionReadinessAdapter.name);
  private readonly execFile: FixedExecFile;
  private readonly files: MotionFiles;
  constructor(dependencies: MotionReadinessDependencies = {}) {
    this.execFile = dependencies.execFile ?? defaultExecFile();
    this.files = dependencies.files ?? nodeReadinessFiles;
  }

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    let check = 'motion executable';
    try {
      await this.execFile('/usr/bin/which', ['motion'], READINESS_COMMAND_OPTIONS);
      check = 'ffmpeg executable';
      await this.execFile('/usr/bin/which', ['ffmpeg'], READINESS_COMMAND_OPTIONS);
      check = 'motion configuration';
      const config = await this.files.readFile('/etc/motion/motion.conf');
      const directives = effectiveDirectives(config);
      if (
        directives.get('target_dir') !== '/home/pi/motion/videos' ||
        directives.get('on_movie_end') !== 'curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"'
      ) throw new Error('motion config incomplete');
      check = 'motion media storage';
      await this.files.access('/home/pi/motion/videos', READINESS_MEDIA_DIRECTORY_ACCESS);
      await this.files.access('/home/pi/motion/thumbnails', READINESS_MEDIA_DIRECTORY_ACCESS);
      check = 'motion service';
      await this.execFile('/bin/systemctl', ['is-active', 'motion.service'], READINESS_COMMAND_OPTIONS);
      check = 'worker groups';
      const groups = await this.execFile('/usr/bin/id', ['-nG'], READINESS_COMMAND_OPTIONS);
      if (!hasGroups(groups.stdout, ['motion', 'video'])) throw new Error('worker groups incomplete');
      return { ready: true, restartScope: 'worker' };
    } catch {
      this.logger.warn(`Feature readiness failed: motion ${check}`);
      return { ready: false, failureCode: 'application-verification-failed' };
    }
  }
}

function effectiveDirectives(config: string): ReadonlyMap<string, string> {
  const directives = new Map<string, string>();
  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(\S+)\s+(.+)$/u.exec(trimmed);
    if (match) directives.set(match[1], match[2].trim());
  }
  return directives;
}
