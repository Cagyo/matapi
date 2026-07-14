import { Inject, Injectable } from '@nestjs/common';
import {
  SYSTEM_META_REPOSITORY,
  type SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';

const VALID_THRESHOLDS = new Set([70, 75, 80, 85, 90]);
const DEFAULT_THRESHOLD = 80;

@Injectable()
export class SetAutoCleanThresholdUseCase {
  constructor(
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
  ) {}

  async execute(value: 70 | 75 | 80 | 85 | 90): Promise<number> {
    if (!VALID_THRESHOLDS.has(value)) throw new RangeError('Unsupported auto-clean threshold');
    await this.meta.set('auto_clean_threshold', String(value));
    return value;
  }

  async current(): Promise<number> {
    const value = Number(await this.meta.get('auto_clean_threshold'));
    return VALID_THRESHOLDS.has(value) ? value : DEFAULT_THRESHOLD;
  }
}
