import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";

import {
  LIVE_VIEW_SETTINGS_JOB_REPOSITORY,
  type LiveViewSettingsJobRepositoryPort,
} from "../domain/ports/live-view-settings-job-repository.port";
import {
  ReconcileLiveViewSettingsJobUseCase,
  type ReconcileLiveViewSettingsJobResult,
} from "./reconcile-live-view-settings-job.use-case";

/** Resumes the one globally active settings mutation during application boot. */
@Injectable()
export class LiveViewSettingsRecoveryService implements OnApplicationBootstrap {
  constructor(
    @Inject(LIVE_VIEW_SETTINGS_JOB_REPOSITORY)
    private readonly jobs: LiveViewSettingsJobRepositoryPort,
    private readonly reconcile: ReconcileLiveViewSettingsJobUseCase,
  ) {}

  async run(): Promise<ReconcileLiveViewSettingsJobResult | null> {
    const active = await this.jobs.findActive();
    const recoverable = active ?? (await this.jobs.findLatestTerminal());
    if (recoverable === null) return null;
    return this.reconcile.execute(recoverable.id);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.run().catch(() => undefined);
  }
}
