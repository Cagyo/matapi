import { Inject, Injectable } from '@nestjs/common';
import { MotionWatcherService } from './motion-watcher.service';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';
import { MOTION_CONTROL, type MotionControlPort } from '../domain/ports/motion-control.port';
import {
  LIVE_SOURCE_SESSION_CONTROL,
  type LiveSourceSessionControlPort,
} from '../domain/ports/live-source-session-control.port';
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
    @Inject(LIVE_SOURCE_SESSION_CONTROL)
    private readonly sessions: LiveSourceSessionControlPort,
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
