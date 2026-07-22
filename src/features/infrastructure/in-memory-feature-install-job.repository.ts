import { FeatureInstallBusyError } from '../domain/errors/feature-install-busy.error';
import { FeatureStateChangedError } from '../domain/errors/feature-state-changed.error';
import type {
  CreateFeatureInstallJob,
  FeatureAttentionReason,
  FeatureInstallFailureCode,
  FeatureInstallJob,
  RestartScope,
} from '../domain/manageable-feature';
import type { FeatureInstallJobRepositoryPort } from '../domain/ports/feature-install-job.repository.port';
import type { FeatureRepositoryPort } from '../domain/ports/feature-repository.port';

/** In-memory `FeatureInstallJobRepositoryPort` for use-case tests and mock mode. */
export class InMemoryFeatureInstallJobRepository implements FeatureInstallJobRepositoryPort {
  private readonly jobs = new Map<string, FeatureInstallJob>();

  constructor(private readonly features: FeatureRepositoryPort) {}

  async createQueued(input: CreateFeatureInstallJob): Promise<FeatureInstallJob> {
    const feature = await this.features.findByName(input.feature);
    if (!feature
      || feature.installed !== input.expected.installed
      || feature.enabled !== input.expected.enabled) {
      throw new FeatureStateChangedError(input.feature);
    }
    const active = await this.findActive();
    if (active) throw new FeatureInstallBusyError(active.feature);
    const job: FeatureInstallJob = {
      id: input.id,
      feature: input.feature,
      status: 'queued',
      activeSlot: 1,
      requestedByUserId: input.requestedByUserId,
      requestedInChatId: input.requestedInChatId,
      workflowReceiptId: input.workflowReceiptId,
      previousInstalled: feature.installed,
      previousEnabled: feature.enabled,
      restartScope: null,
      failureCode: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async findById(id: string): Promise<FeatureInstallJob | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async findActive(): Promise<FeatureInstallJob | null> {
    const job = [...this.jobs.values()].find((candidate) => candidate.activeSlot === 1);
    return job ? { ...job } : null;
  }

  async listRecentTerminal(limit: number): Promise<readonly FeatureInstallJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'succeeded' || job.status === 'failed')
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  async markRunning(id: string, now: Date): Promise<FeatureInstallJob> {
    const job = this.requireActive(id, false);
    job.status = 'running';
    job.updatedAt = now;
    return { ...job };
  }

  async terminalizeSuccess(input: { id: string; restartScope: RestartScope; now: Date }): Promise<FeatureInstallJob> {
    const job = this.requireActive(input.id, false);
    const current = await this.requireFeature(job.feature);
    await this.features.setVerified({ name: job.feature, installed: true, attentionReason: null });
    await this.features.compareAndSetEnabled({
      name: job.feature,
      expected: { installed: true, enabled: current.enabled, attentionReason: null },
      enabled: true,
    });
    job.status = 'succeeded';
    job.activeSlot = null;
    job.restartScope = input.restartScope;
    job.failureCode = null;
    job.updatedAt = input.now;
    return { ...job };
  }

  async terminalizeFailure(input: {
    id: string;
    failureCode: FeatureInstallFailureCode;
    attentionReason: FeatureAttentionReason | null;
    preservePreviousState: boolean;
    now: Date;
  }): Promise<FeatureInstallJob> {
    const job = this.requireActive(input.id, true);
    if (input.preservePreviousState) {
      const current = await this.requireFeature(job.feature);
      await this.features.setVerified({
        name: job.feature,
        installed: job.previousInstalled,
        attentionReason: input.attentionReason,
      });
      await this.features.compareAndSetEnabled({
        name: job.feature,
        expected: {
          installed: job.previousInstalled,
          enabled: current.enabled,
          attentionReason: input.attentionReason,
        },
        enabled: job.previousEnabled,
      });
    } else {
      await this.features.setAttention(job.feature, input.attentionReason);
    }
    job.status = 'failed';
    job.activeSlot = null;
    job.restartScope = null;
    job.failureCode = input.failureCode;
    job.updatedAt = input.now;
    return { ...job };
  }

  private requireActive(id: string, allowQueued: boolean): FeatureInstallJob {
    const job = this.jobs.get(id);
    if (!job || job.activeSlot !== 1 || (job.status !== 'running' && !(allowQueued && job.status === 'queued'))) {
      throw new RangeError(`Install job '${id}' is not active`);
    }
    return job;
  }

  private async requireFeature(name: FeatureInstallJob['feature']) {
    const feature = await this.features.findByName(name);
    if (!feature) throw new RangeError(`Feature '${name}' is missing`);
    return feature;
  }
}
