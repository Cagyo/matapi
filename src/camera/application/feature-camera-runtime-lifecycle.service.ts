import { Inject, Injectable } from '@nestjs/common';
import { MotionWatcherService } from './motion-watcher.service';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';
import { LiveStreamSessionService } from './live-stream-session.service';
import { MOTION_CONTROL, type MotionControlPort } from '../domain/ports/motion-control.port';
import type { FeatureRuntimeLifecyclePort } from '../../features/domain/ports/feature-runtime-lifecycle.port';

/** Runtime transitions that must complete around camera feature state changes. */
@Injectable()
export class FeatureCameraRuntimeLifecycleService {
  readonly motion: FeatureRuntimeLifecyclePort;
  readonly rtsp: FeatureRuntimeLifecyclePort;

  constructor(
    private readonly watcher: MotionWatcherService,
    @Inject(MOTION_CONTROL) private readonly motionControl: MotionControlPort,
    private readonly gate: RtspSourceStartGate,
    private readonly sessions: LiveStreamSessionService,
  ) {
    this.motion = {
      beforeDisable: async () => {
        await this.watcher.stop();
        await this.motionControl.stop();
      },
      afterEnable: () => this.watcher.start(),
    };
    this.rtsp = {
      beforeDisable: async () => {
        this.gate.close();
        await this.sessions.stopSourceKind('rtsp');
      },
      afterEnable: () => this.gate.open(),
    };
  }
}
