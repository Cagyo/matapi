export interface CameraBackendPort {
  captureSnapshot(): Promise<Buffer>;
  probe(): Promise<boolean>;
  destroy?(): Promise<void>;
}
