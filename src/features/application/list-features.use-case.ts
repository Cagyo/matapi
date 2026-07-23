import { Injectable } from '@nestjs/common';
import type { FeatureStatus } from '../domain/feature-status';
import { ListManageableFeaturesUseCase } from './list-manageable-features.use-case';

/** Temporary compatibility facade for the legacy feature-list handler. */
@Injectable()
export class ListFeaturesUseCase {
  constructor(
    private readonly list: ListManageableFeaturesUseCase,
    _legacyDescriptionResolver?: unknown,
  ) {}

  execute(): Promise<FeatureStatus[]> {
    return this.list.execute();
  }
}
