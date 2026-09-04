import { Inject, Injectable } from '@nestjs/common';
import { LiveViewSettingsBusyError } from '../domain/errors/live-view-settings-busy.error';
import {
  LIVE_VIEW_SETTINGS_JOB_REPOSITORY,
  type LiveViewSettingsJobRepositoryPort,
} from '../domain/ports/live-view-settings-job-repository.port';
import { MotionWatcherService } from './motion-watcher.service';
import {
  LiveViewPolicyCoordinatorService,
  type LiveViewPolicyMutationLease,
} from './live-view-policy-coordinator.service';
import {
  LiveViewPolicyRestartPendingError,
  ReconcileRtspPolicyUseCase,
} from './reconcile-rtsp-policy.use-case';
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
  private activeRtspLease: LiveViewPolicyMutationLease | null = null;

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
      runTransition: (operation) => this.coordinator.run('rtsp-state', async (lease) => {
        await this.requireNoActiveSettingsJob();
        this.activeRtspLease = lease;
        try {
          return await operation();
        } finally {
          this.activeRtspLease = null;
        }
      }),
      beforeDisable: async () => {
        this.requireNoRestartPending();
        this.gate.close();
        await this.sessions.stopSourceKind('rtsp');
        await this.reconcilePolicy(false);
      },
      afterEnable: async () => {
        this.requireNoRestartPending();
        await this.reconcilePolicy(true);
        await this.gate.open();
      },
    };
  }

  private async requireNoActiveSettingsJob(): Promise<void> {
    if (await this.settingsJobs.findActive()) throw new LiveViewSettingsBusyError();
  }

  private requireNoRestartPending(): void {
    if (this.coordinator.isRestartPending()) throw new LiveViewSettingsBusyError();
  }

  private async reconcilePolicy(rtspEnabled: boolean): Promise<void> {
    try {
      await this.reconcileRtspPolicy.execute({ rtspEnabled });
    } catch (error) {
      if (error instanceof LiveViewPolicyRestartPendingError) {
        this.activeRtspLease?.markRestartPending();
      }
      throw error;
    }
  }
}
