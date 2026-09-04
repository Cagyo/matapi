import { Inject, Injectable } from "@nestjs/common";

import {
  PROCESS_RESTARTER,
  type ProcessRestarterPort,
} from "../../system/domain/ports/process-restarter.port";
import {
  CAMERA_CLOCK,
  type CameraClockPort,
} from "../domain/ports/camera-clock.port";
import {
  LIVE_VIEW_SETTINGS_JOB_REPOSITORY,
  type LiveViewSettingsJobRepositoryPort,
} from "../domain/ports/live-view-settings-job-repository.port";
import {
  LIVE_VIEW_SETTINGS_STORE,
  type LiveViewSettingsStorePort,
} from "../domain/ports/live-view-settings-store.port";
import { LiveViewStartGate } from "./live-view-start-gate.service";

const RESTART_ACTIVATION_DEADLINE_MS = 15_000;

/** Keeps a committed settings job fenced until a replacement process boots. */
@Injectable()
export class LiveViewRestartActivationService {
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(LIVE_VIEW_SETTINGS_JOB_REPOSITORY)
    private readonly jobs: LiveViewSettingsJobRepositoryPort,
    @Inject(LIVE_VIEW_SETTINGS_STORE)
    private readonly settings: LiveViewSettingsStorePort,
    private readonly gate: LiveViewStartGate,
    @Inject(PROCESS_RESTARTER)
    private readonly restarter: ProcessRestarterPort,
    @Inject(CAMERA_CLOCK)
    private readonly clock: CameraClockPort,
  ) {}

  arm(jobId: string, oldGeneration: number): void {
    this.cancelOnBoot(jobId);
    this.gate.close();
    const deadline = setTimeout(() => {
      this.deadlines.delete(jobId);
      if (this.settings.bootLoadedGeneration() !== oldGeneration) return;
      void this.jobs
        .markRestartRequired(
          jobId,
          "restart-activation-timeout",
          this.clock.now(),
        )
        .catch(() => undefined);
    }, RESTART_ACTIVATION_DEADLINE_MS);
    this.deadlines.set(jobId, deadline);
  }

  async retry(_jobId: string): Promise<void> {
    await this.restarter.restart(() =>
      this.settings.simulateDevelopmentRestart(),
    );
  }

  cancelOnBoot(jobId: string): void {
    const deadline = this.deadlines.get(jobId);
    if (deadline === undefined) return;
    clearTimeout(deadline);
    this.deadlines.delete(jobId);
  }
}
