export const ARCHIVE_PROVIDER_STATE_REPOSITORY = Symbol('ARCHIVE_PROVIDER_STATE_REPOSITORY');

export type ArchiveProviderOperationClass = 'account' | 'folder' | 'upload' | 'reconcile' | 'delete';
export type ArchiveProviderFailureClass = 'transport' | 'rate-limit' | 'quota' | 'capacity' | 'authorization' | 'policy';

export interface ArchiveProviderState {
  revision: number;
  generationId: string | null;
  operationClass: ArchiveProviderOperationClass | null;
  failureClass: ArchiveProviderFailureClass | null;
  failureStreak: number;
  cooldownUntilMs: number | null;
  blockReason: string | null;
  updatedAtMs: number;
}

export interface ArchiveProviderStateRepositoryPort {
  load(): Promise<ArchiveProviderState>;
  activateGeneration(expectedRevision: number, generationId: string, nowMs: number): Promise<boolean>;
  compareAndSet(expectedRevision: number, next: Omit<ArchiveProviderState, 'revision'>): Promise<boolean>;
}
