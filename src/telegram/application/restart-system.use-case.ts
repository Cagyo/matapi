import { Inject, Injectable } from '@nestjs/common';
import {
  PROCESS_RESTARTER,
  ProcessRestarterPort,
} from '../../system/domain/ports/process-restarter.port';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';

export const RESTART_REASON_KEY = 'restart_reason';
export const RESTART_REASON_USER_COMMAND = 'user_command';

/** Spec 13 — `/restart`. Admin-only at the handler layer. */
@Injectable()
export class RestartSystemUseCase {
  constructor(
    @Inject(SYSTEM_META_REPOSITORY)
    private readonly meta: SystemMetaRepositoryPort,
    @Inject(PROCESS_RESTARTER)
    private readonly restarter: ProcessRestarterPort,
  ) {}

  /**
   * The handler must `await ctx.reply(...)` before calling `execute()` —
   * grammY needs to flush the message before pm2 sends SIGINT.
   */
  async execute(): Promise<void> {
    await this.meta.set(RESTART_REASON_KEY, RESTART_REASON_USER_COMMAND);
    await this.restarter.restart();
  }
}
