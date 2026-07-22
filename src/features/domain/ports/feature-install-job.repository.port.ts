import type {
  CreateFeatureInstallJob,
  FeatureAttentionReason,
  FeatureInstallFailureCode,
  FeatureInstallJob,
  RestartScope,
} from '../manageable-feature';

export const FEATURE_INSTALL_JOB_REPOSITORY = Symbol('FEATURE_INSTALL_JOB_REPOSITORY');

export interface FeatureInstallJobRepositoryPort {
  createQueued(input: CreateFeatureInstallJob): Promise<FeatureInstallJob>;
  findById(id: string): Promise<FeatureInstallJob | null>;
  findActive(): Promise<FeatureInstallJob | null>;
  listRecentTerminal(limit: number): Promise<readonly FeatureInstallJob[]>;
  markRunning(id: string, now: Date): Promise<FeatureInstallJob>;
  terminalizeSuccess(input: {
    id: string;
    restartScope: RestartScope;
    now: Date;
  }): Promise<FeatureInstallJob>;
  terminalizeFailure(input: {
    id: string;
    failureCode: FeatureInstallFailureCode;
    attentionReason: FeatureAttentionReason | null;
    preservePreviousState: boolean;
    now: Date;
  }): Promise<FeatureInstallJob>;
}
