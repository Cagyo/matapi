/** Resolved camera runtime mode (real Motion daemon vs. stub). */
export const CAMERA_MODE = Symbol('CAMERA_MODE');
export type CameraMode = 'real' | 'stub';
