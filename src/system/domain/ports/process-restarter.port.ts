export const PROCESS_RESTARTER = Symbol('PROCESS_RESTARTER');

/**
 * Triggers a process-supervisor restart (PM2 in production). Implementations
 * must not return before the supervisor has been instructed to restart; the
 * worker process will be torn down shortly after.
 */
export interface ProcessRestarterPort {
  restart(): Promise<void>;
}
