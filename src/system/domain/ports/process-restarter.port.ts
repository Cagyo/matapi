export const PROCESS_RESTARTER = Symbol("PROCESS_RESTARTER");

/**
 * Triggers a process-supervisor restart (PM2 in production). Implementations
 * must not resolve until the fixed supervisor command exits successfully.
 * Development implementations may invoke the supplied process-local activation
 * seam instead of starting a supervisor.
 */
export interface ProcessRestarterPort {
  restart(simulateDevelopmentRestart?: () => Promise<void>): Promise<void>;
}
