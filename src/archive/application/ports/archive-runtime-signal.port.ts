/** Provider-neutral runtime progress reported by Camera to Archive. */
export interface ArchiveRuntimeSignalPort {
  motionTraversalCompleted(completedAtMs: number): Promise<void>;
}

export const ARCHIVE_RUNTIME_SIGNAL = Symbol('ARCHIVE_RUNTIME_SIGNAL');
