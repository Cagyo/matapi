import { Inject, Injectable } from '@nestjs/common';
import { LiveViewSettingsBusyError } from '../domain/errors/live-view-settings-busy.error';
import {
  LIVE_VIEW_SETTINGS_JOB_REPOSITORY,
  type LiveViewSettingsJobRepositoryPort,
} from '../domain/ports/live-view-settings-job-repository.port';
import { MotionWatcherService } from './motion-watcher.service';
import { LiveViewPolicyCoordinatorService } from './live-view-policy-coordinator.service';
import { ReconcileRtspPolicyUseCase } from './reconcile-rtsp-policy.use-case';
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
    @Inject(LIVE_VIEW_SETTINGS_JOB_REPOSITORY)
    private readonly settingsJobs: Pick<LiveViewSettingsJobRepositoryPort, 'findActive'>,
    private readonly coordinator: LiveViewPolicyCoordinatorService,
    private readonly reconcileRtspPolicy: ReconcileRtspPolicyUseCase,
  ) {
    this.motion = {
      beforeDisable: async () => {
        await this.watcher.stop();
        await this.motionControl.stop();
      },
      afterEnable: () => this.watcher.start(),
    };
    this.rtsp = {
      beforeDisable: () => this.coordinator.run('rtsp-state', async () => {
        await this.requireNoActiveSettingsJob();
        this.gate.close();
        await this.sessions.stopSourceKind('rtsp');
        await this.reconcileRtspPolicy.execute({ rtspEnabled: false });
      }),
      afterEnable: () => this.coordinator.run('rtsp-state', async () => {
        await this.requireNoActiveSettingsJob();
        await this.reconcileRtspPolicy.execute({ rtspEnabled: true });
        await this.gate.open();
      }),
    };
  }

  private async requireNoActiveSettingsJob(): Promise<void> {
    if (await this.settingsJobs.findActive()) throw new LiveViewSettingsBusyError();
  }
}
