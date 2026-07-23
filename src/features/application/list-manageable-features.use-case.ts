import { Inject, Injectable } from '@nestjs/common';
import { MANAGEABLE_FEATURE_NAMES } from '../domain/manageable-feature';
import type { FeatureStatus } from '../domain/feature-status';
import {
  FEATURE_AVAILABILITY,
  type FeatureAvailabilityPort,
} from '../domain/ports/feature-availability.port';

@Injectable()
export class ListManageableFeaturesUseCase {
  constructor(
    @Inject(FEATURE_AVAILABILITY)
    private readonly availability: FeatureAvailabilityPort,
  ) {}

  execute(): Promise<FeatureStatus[]> {
    return Promise.all(MANAGEABLE_FEATURE_NAMES.map((name) => this.availability.inspect(name)));
  }
}
