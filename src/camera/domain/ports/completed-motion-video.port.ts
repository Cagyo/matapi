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

/** Cheap stable-file identity retained by one process-local traversal. */
export interface CompletedMotionVideoCandidate {
  sourceIdentity: string;
  trustedPath: string;
  relativePath: string;
  size: number;
  mtimeNs: string;
  sourceTimeMs: number;
}

export type CompletedMotionHashResult =
  | { kind: 'in-progress'; hashedBytes: number }
  | { kind: 'rejected'; hashedBytes: number }
  | { kind: 'complete'; descriptor: CompletedMotionVideoDescriptor; hashedBytes: number };

/** Opaque adapter-owned traversal. No filesystem or hashing provider state crosses this boundary. */
export interface CompletedMotionVideoTraversal {
  pendingCandidate(): CompletedMotionVideoCandidate | null;
  inspect(candidatePath: string, signal: AbortSignal): Promise<CompletedMotionVideoCandidate | null>;
  nextCandidate(input: { entryLimit: number }, signal: AbortSignal): Promise<{
    candidate: CompletedMotionVideoCandidate | null;
    visitedEntries: number;
    complete: boolean;
  }>;
  continueHash(candidate: CompletedMotionVideoCandidate, input: {
    hashByteLimit: number;
    deadlineMonotonicMs: number;
  }, signal: AbortSignal): Promise<CompletedMotionHashResult>;
  close(): Promise<void>;
}

export const COMPLETED_MOTION_VIDEO = Symbol('COMPLETED_MOTION_VIDEO');

/** Camera-owned trust boundary for Motion's completed local video files. */
export interface CompletedMotionVideoPort {
  resolve(candidatePath: string, signal?: AbortSignal): Promise<CompletedMotionVideoDescriptor | null>;
  openTraversal(signal: AbortSignal): Promise<CompletedMotionVideoTraversal>;
}
