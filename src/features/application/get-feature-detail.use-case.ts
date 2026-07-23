import { Inject, Injectable } from '@nestjs/common';
import type { FeatureStatus } from '../domain/feature-status';
import { isManageableFeature, type ManageableFeatureName, type RestartScope } from '../domain/manageable-feature';
import { UnknownFeatureError } from '../domain/errors/unknown-feature.error';
import {
  FEATURE_AVAILABILITY,
  type FeatureAvailabilityPort,
} from '../domain/ports/feature-availability.port';

export interface FeatureImpact {
  dependencies: 'pigpiod' | 'uart' | 'mosquitto' | 'motion' | 'rtsp-runtime';
  controls: 'digital-sensors' | 'uart-sensors' | 'mqtt-sensors' | 'motion-camera' | 'live-streams';
  monitoring: 'sensor-work' | 'camera-work';
  restartScope: RestartScope;
}

export interface FeatureDetail {
  status: FeatureStatus;
  impact: FeatureImpact;
}

const IMPACT: Record<ManageableFeatureName, Omit<FeatureImpact, 'restartScope'>> = {
  digital: { dependencies: 'pigpiod', controls: 'digital-sensors', monitoring: 'sensor-work' },
  uart: { dependencies: 'uart', controls: 'uart-sensors', monitoring: 'sensor-work' },
  zigbee: { dependencies: 'mosquitto', controls: 'mqtt-sensors', monitoring: 'sensor-work' },
  motion: { dependencies: 'motion', controls: 'motion-camera', monitoring: 'camera-work' },
  rtsp: { dependencies: 'rtsp-runtime', controls: 'live-streams', monitoring: 'camera-work' },
};

@Injectable()
export class GetFeatureDetailUseCase {
  constructor(
    @Inject(FEATURE_AVAILABILITY)
    private readonly availability: FeatureAvailabilityPort,
  ) {}

  async execute(name: string): Promise<FeatureDetail> {
    if (!isManageableFeature(name)) throw new UnknownFeatureError(name);
    const status = await this.availability.inspect(name);
    return { status, impact: { ...IMPACT[name], restartScope: restartScopeFor(status) } };
  }
}

function restartScopeFor(status: FeatureStatus): RestartScope {
  if (status.action === 'install') {
    if (status.name === 'uart') return 'host';
    if (status.name === 'motion' || status.name === 'rtsp') return 'supervisor';
  }
  return 'worker';
}
