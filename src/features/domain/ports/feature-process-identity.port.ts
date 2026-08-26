export const FEATURE_PROCESS_IDENTITY = Symbol('FEATURE_PROCESS_IDENTITY');

/**
 * Identity of the running worker process. An install that awaits a restart is
 * only verifiable once this value differs from the one it recorded, so the
 * value must change on every process start and on every reboot — a PID alone
 * is reused, and a start time alone repeats across boots.
 */
export interface FeatureProcessIdentityPort {
  /** `<linux-boot-id>:<proc-self-start-ticks>`. */
  current(): Promise<string>;
}
