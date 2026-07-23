export const FEATURE_INSTALL_CONTROLLER = Symbol('FEATURE_INSTALL_CONTROLLER');

export interface FeatureInstallControllerPort {
  start(): Promise<void>;
}
