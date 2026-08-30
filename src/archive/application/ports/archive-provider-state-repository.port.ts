export const ARCHIVE_PROVIDER_STATE_REPOSITORY = Symbol('ARCHIVE_PROVIDER_STATE_REPOSITORY');

export type ArchiveProviderOperationClass = 'account' | 'folder' | 'upload' | 'reconcile' | 'delete';
export type ArchiveProviderFailureClass = 'transport' | 'rate-limit' | 'quota' | 'capacity' | 'authorization' | 'policy';
export type ArchiveProviderBlockReason =
  | 'quota_exhausted'
  | 'account_creation_limit'
  | 'policy_blocked'
  | 'reauthorization_required';
export type ArchiveProviderProbeReason = 'cooldown' | 'quota' | 'capacity' | 'policy';

export interface ArchiveProviderState {
  revision: number;
  generationId: string | null;
  operationClass: ArchiveProviderOperationClass | null;
  failureClass: ArchiveProviderFailureClass | null;
  failureStreak: number;
  cooldownUntilMs: number | null;
  blockReason: ArchiveProviderBlockReason | null;
  updatedAtMs: number;
}

export interface ArchiveProviderStateRepositoryPort {
  load(): Promise<ArchiveProviderState>;
  activateGeneration(expectedRevision: number, generationId: string, nowMs: number): Promise<boolean>;
  compareAndSet(expectedRevision: number, next: Omit<ArchiveProviderState, 'revision'>): Promise<boolean>;
  requestProbe(input: {
    generationId: string;
    expectedRevision: number;
    allowedBlockReasons: readonly ('account_creation_limit' | 'policy_blocked')[];
    nowMs: number;
  }): Promise<boolean>;
}

/** In-process parity transaction used when provider and credential state must settle together. */
export interface ArchiveProviderStateTransactionPort {
  withArchiveProviderStateTransaction<T>(
    operation: (state: ArchiveProviderStateRepositoryPort) => Promise<T>,
  ): Promise<T>;
}
