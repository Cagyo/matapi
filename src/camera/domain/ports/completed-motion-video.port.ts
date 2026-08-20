/** A completed, immutable Motion video accepted by the camera filesystem boundary. */
export interface CompletedMotionVideoDescriptor {
  kind: 'motion_video';
  sourceIdentity: string;
  trustedPath: string;
  relativePath: string;
  size: number;
  mtimeNs: string;
  sourceTimeMs: number;
  sha256: string;
  sourceFingerprint: string;
}

/** Serializable, process-local position in one deterministic filesystem traversal. */
export interface CompletedMotionVideoScanCursor {
  readonly frames: readonly {
    relativeDirectory: string;
    nextEntry: number;
  }[];
}

export interface CompletedMotionVideoScanBatch {
  descriptors: readonly CompletedMotionVideoDescriptor[];
  cursor: CompletedMotionVideoScanCursor | null;
  complete: boolean;
  visitedEntries: number;
}

export interface CompletedMotionRecoveryBatch {
  cursor: CompletedMotionVideoScanCursor | null;
  complete: boolean;
}

export const COMPLETED_MOTION_VIDEO = Symbol('COMPLETED_MOTION_VIDEO');

/** Camera-owned trust boundary for Motion's completed local video files. */
export interface CompletedMotionVideoPort {
  resolve(candidatePath: string): Promise<CompletedMotionVideoDescriptor | null>;
  scanBatch(input: {
    cursor: CompletedMotionVideoScanCursor | null;
    entryLimit: number;
  }): Promise<CompletedMotionVideoScanBatch>;
}
