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

export const COMPLETED_MOTION_VIDEO = Symbol('COMPLETED_MOTION_VIDEO');

/** Camera-owned trust boundary for Motion's completed local video files. */
export interface CompletedMotionVideoPort {
  resolve(candidatePath: string): Promise<CompletedMotionVideoDescriptor | null>;
  scan(limit: number): Promise<readonly CompletedMotionVideoDescriptor[]>;
}
