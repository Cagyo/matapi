import type {
  LiveViewSettingsJob,
  LiveViewSettingsJobFailureCode,
} from '../live-view-settings-job';
import type { LiveViewSettingsCandidate } from '../live-view-settings';

export const LIVE_VIEW_SETTINGS_JOB_REPOSITORY = Symbol('LIVE_VIEW_SETTINGS_JOB_REPOSITORY');

export interface PrepareLiveViewSettingsJobInput {
  readonly id: string;
  readonly expectedGeneration: number;
  readonly candidateSettings: LiveViewSettingsCandidate;
  readonly requestedByUserId: number;
  readonly requestedInChatId: number;
  readonly workflowReceiptId: string;
  readonly now: Date;
}

export interface LiveViewSettingsJobRepositoryPort {
  findById(id: string): Promise<LiveViewSettingsJob | null>;
  findActive(): Promise<LiveViewSettingsJob | null>;
  findLatestTerminal(): Promise<LiveViewSettingsJob | null>;
  markPublished(id: string, now: Date): Promise<LiveViewSettingsJob>;
  markCommitted(id: string, now: Date): Promise<LiveViewSettingsJob>;
  markRestartRequired(
    id: string,
    code: 'restart-dispatch-failed' | 'restart-activation-timeout',
    now: Date,
  ): Promise<LiveViewSettingsJob>;
  terminalizeSuccess(id: string, now: Date): Promise<LiveViewSettingsJob>;
  terminalizeFailure(
    id: string,
    code: LiveViewSettingsJobFailureCode,
    now: Date,
  ): Promise<LiveViewSettingsJob>;
}
