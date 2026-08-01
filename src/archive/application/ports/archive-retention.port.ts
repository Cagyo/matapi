export const ARCHIVE_RETENTION = Symbol('ARCHIVE_RETENTION');

export interface ArchiveRetentionInput {
  requiredBytes: number;
}

export interface ArchiveRetentionResult {
  deletedIds: readonly string[];
  reclaimedBytes: number;
  remainingDeficitBytes: number;
  accountingWindowActive: boolean;
}

/** Provider-neutral exact-ID retention boundary for schedulers and other contexts. */
export interface ArchiveRetentionPort {
  execute(
    input: ArchiveRetentionInput,
    signal: AbortSignal,
  ): Promise<ArchiveRetentionResult>;
}
