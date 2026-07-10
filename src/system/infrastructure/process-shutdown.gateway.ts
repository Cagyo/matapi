import { Logger } from '@nestjs/common';

export interface ProcessShutdownActions {
  prepare(signal: string): Promise<void>;
  closeApplication(): Promise<void>;
  releaseLock(): void;
  setExitCode(code: number): void;
}

/**
 * Owns process-signal shutdown orchestration. The bootstrap composes the
 * actions so this gateway stays independent of Nest application types.
 */
export class ProcessShutdownGateway {
  private shutdown?: Promise<void>;

  constructor(private readonly actions: ProcessShutdownActions) {}

  run(signal: string): Promise<void> {
    this.shutdown ??= this.perform(signal);
    return this.shutdown;
  }

  private async perform(signal: string): Promise<void> {
    Logger.log(`Received ${signal}, shutting down`, ProcessShutdownGateway.name);
    let exitCode = 0;

    try {
      try {
        await this.actions.prepare(signal);
      } catch (error) {
        this.logError('Graceful shutdown preparation failed', error);
      }

      try {
        await this.actions.closeApplication();
      } catch (error) {
        exitCode = 1;
        this.logError('Application close failed', error);
      }
    } finally {
      try {
        this.actions.releaseLock();
      } catch (error) {
        exitCode = 1;
        this.logError('PID lock release failed', error);
      }
    }

    this.actions.setExitCode(exitCode);
  }

  private logError(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unknown error';
    Logger.warn(`${operation}: ${message}`, ProcessShutdownGateway.name);
  }
}
