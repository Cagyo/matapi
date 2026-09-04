import { LiveViewSettingsBusyError } from '../domain/errors/live-view-settings-busy.error';
import {
  createLiveViewSettingsJob,
  type LiveViewSettingsJob,
  type LiveViewSettingsJobFailureCode,
  type LiveViewSettingsJobStatus,
} from '../domain/live-view-settings-job';
import type {
  LiveViewSettingsJobRepositoryPort,
  PrepareLiveViewSettingsJobInput,
} from '../domain/ports/live-view-settings-job-repository.port';

interface StoredJob {
  job: LiveViewSettingsJob;
  requestedByUserId: number;
  requestedInChatId: number;
  workflowReceiptId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** In-memory settings-job authority shared with the in-memory Telegram claim adapter. */
export class InMemoryLiveViewSettingsJobRepository implements LiveViewSettingsJobRepositoryPort {
  private readonly jobs = new Map<string, StoredJob>();

  claimPrepared(input: PrepareLiveViewSettingsJobInput): LiveViewSettingsJob {
    if ([...this.jobs.values()].some(({ job }) => job.activeSlot === 1)) {
      throw new LiveViewSettingsBusyError();
    }
    const job = createLiveViewSettingsJob({
      id: input.id,
      status: 'prepared',
      expectedGeneration: input.expectedGeneration,
      candidateSettings: input.candidateSettings,
      failureCode: null,
    });
    this.jobs.set(job.id, {
      job,
      requestedByUserId: input.requestedByUserId,
      requestedInChatId: input.requestedInChatId,
      workflowReceiptId: input.workflowReceiptId,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    });
    return cloneJob(job);
  }

  async findById(id: string): Promise<LiveViewSettingsJob | null> {
    const stored = this.jobs.get(id);
    return stored ? cloneJob(stored.job) : null;
  }

  async findActive(): Promise<LiveViewSettingsJob | null> {
    const stored = [...this.jobs.values()].find(({ job }) => job.activeSlot === 1);
    return stored ? cloneJob(stored.job) : null;
  }

  async findLatestTerminal(): Promise<LiveViewSettingsJob | null> {
    const [stored] = [...this.jobs.values()]
      .filter(({ job }) => job.status === 'succeeded' || job.status === 'failed')
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.job.id.localeCompare(left.job.id),
      );
    return stored ? cloneJob(stored.job) : null;
  }

  async markPublished(id: string, now: Date): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['prepared'], 'published', null, now);
  }

  async markCommitted(id: string, now: Date): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['published'], 'committed', null, now);
  }

  async markRestartRequired(
    id: string,
    code: 'restart-dispatch-failed' | 'restart-activation-timeout',
    now: Date,
  ): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['committed'], 'restart-required', code, now);
  }

  async terminalizeSuccess(id: string, now: Date): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['committed', 'restart-required'], 'succeeded', null, now);
  }

  async terminalizeFailure(
    id: string,
    code: LiveViewSettingsJobFailureCode,
    now: Date,
  ): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['prepared', 'published'], 'failed', code, now);
  }

  private transition(
    id: string,
    allowed: readonly LiveViewSettingsJobStatus[],
    status: LiveViewSettingsJobStatus,
    failureCode: LiveViewSettingsJobFailureCode | null,
    now: Date,
  ): LiveViewSettingsJob {
    const stored = this.jobs.get(id);
    if (stored?.job.activeSlot !== 1 || !allowed.includes(stored.job.status)) {
      throw new RangeError(`Live view settings job '${id}' state changed`);
    }
    const job: LiveViewSettingsJob = {
      ...stored.job,
      status,
      activeSlot: status === 'succeeded' || status === 'failed' ? null : 1,
      failureCode,
    };
    stored.job = job;
    stored.updatedAt = new Date(now);
    return cloneJob(job);
  }
}

function cloneJob(job: LiveViewSettingsJob): LiveViewSettingsJob {
  return {
    ...job,
    candidateSettings: {
      ...job.candidateSettings,
      allowedCameraCidrs: [...job.candidateSettings.allowedCameraCidrs],
    },
  };
}
