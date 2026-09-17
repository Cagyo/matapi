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
import type { LiveViewSettingsStorePort } from '../domain/ports/live-view-settings-store.port';
import { LiveViewReadinessBarrierService } from './live-view-readiness-barrier.service';
import { LiveViewStartGate } from './live-view-start-gate.service';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';
import { LiveViewSettingsOutcomeRegistryService } from './live-view-settings-outcome-registry.service';
import { FEATURE_QUERY, type FeatureQueryPort } from '../../features/domain/ports/feature-query.port';
import { ReconcileRtspPolicyUseCase } from './reconcile-rtsp-policy.use-case';

/** Resumes the one globally active settings mutation during application boot. */
@Injectable()
export class LiveViewSettingsRecoveryService implements OnApplicationBootstrap {
  private running?: Promise<ReconcileLiveViewSettingsJobResult | null>;
  constructor(
    @Inject(LIVE_VIEW_SETTINGS_JOB_REPOSITORY)
    private readonly jobs: LiveViewSettingsJobRepositoryPort,
    private readonly reconcile: ReconcileLiveViewSettingsJobUseCase,
    private readonly settings?: LiveViewSettingsStorePort,
    private readonly gate?: LiveViewStartGate,
    private readonly rtsp?: RtspSourceStartGate,
    private readonly readiness?: LiveViewReadinessBarrierService,
    private readonly outcomes?: LiveViewSettingsOutcomeRegistryService,
    @Inject(FEATURE_QUERY) private readonly features?: FeatureQueryPort,
    private readonly reconcileRtspPolicy?: ReconcileRtspPolicyUseCase,
  ) {}

  run(): Promise<ReconcileLiveViewSettingsJobResult | null> {
    this.running ??= this.recover().catch((error: unknown) => {
      this.readiness?.markFailedClosed();
      throw error;
    });
    return this.running;
  }

  private async recover(): Promise<ReconcileLiveViewSettingsJobResult | null> {
    this.gate?.close();
    this.rtsp?.close();
    const committed = await this.settings?.readCommitted();
    const active = await this.jobs.findActive();
    const recoverable = active ?? (await this.jobs.findLatestTerminal());
    const result = recoverable ? await this.reconcile.execute(recoverable.id) : null;
    if (result?.kind === 'pending' || result?.kind === 'resumed' || result?.kind === 'restart-required') {
      this.readiness?.markFailedClosed();
      return result;
    }
    let reopenLiveView = !recoverable && committed?.enabled && committed.generation === this.settings?.bootLoadedGeneration();
    if (recoverable && this.gate) {
      try {
        this.gate.assertCanStart();
        reopenLiveView = true;
      } catch {
        reopenLiveView = false;
      }
    }
    const epoch = this.gate?.close();
    const rtspFeature = (await this.features?.listAll())?.find(feature => feature.name === 'rtsp');
    if (rtspFeature?.installed === true) {
      await this.reconcileRtspPolicy?.execute({ rtspEnabled: rtspFeature.enabled });
    }
    if (reopenLiveView) this.gate?.openIfCurrent(epoch!);
    if (recoverable) {
      const terminal = await this.jobs.findById(recoverable.id);
      if (terminal?.status === 'succeeded' || terminal?.status === 'failed') {
        await this.outcomes?.notify(terminal);
      }
    }
    await this.rtsp?.open().catch(() => undefined);
    this.readiness?.markReady();
    return result;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.run().catch(() => undefined);
  }
}
