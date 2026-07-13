import { Injectable } from '@nestjs/common';
import type { FeatureDisableLifecyclePort } from '../../features/domain/ports/feature-disable-lifecycle.port';
import { LiveStreamSessionService } from './live-stream-session.service';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';

/** Stops RTSP converter work before the feature flag is persisted disabled. */
@Injectable()
export class DisableRtspFeatureUseCase implements FeatureDisableLifecyclePort {
  constructor(
    private readonly gate: RtspSourceStartGate,
    private readonly sessions: LiveStreamSessionService,
  ) {}

  async beforeDisable(name: string): Promise<void> {
    if (name !== 'rtsp') return;
    this.gate.close();
    await this.sessions.stopSourceKind('rtsp');
  }
}
