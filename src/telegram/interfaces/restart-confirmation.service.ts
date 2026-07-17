import { Inject, Injectable, Logger } from '@nestjs/common';
import { en } from '../../locales/en';
import {
  SYSTEM_META_REPOSITORY,
  SystemMetaRepositoryPort,
} from '../../system/domain/ports/system-meta-repository.port';
import {
  DIRECT_MESSENGER,
  DirectMessengerPort,
} from '../domain/ports/direct-messenger.port';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { RESTART_REASON_KEY } from '../application/restart-system.use-case';
import { RestoreWorkflowOriginUseCase } from '../application/restore-workflow-origin.use-case';
import { catalogFor } from '../../locales';
import type { LocaleCatalog } from '../../locales';
import { WorkflowEntryCoordinator } from './workflow-entry.coordinator';

const UPDATE_COMMIT_KEY = 'update_commit';
const UPDATE_STATUS_KEY = 'update_status';
const ROLLBACK_COMMIT_KEY = 'rollback_commit';

/**
 * Runs once after the bot is online. Reads `system_meta.restart_reason`
 * set by `/restart`, the OTA scripts, or rollback. It completes the matching
 * contextual restart workflow first, falling back to an admin broadcast when
 * none exists, then clears the flag. Idempotent — a fresh boot with no flag
 * is a no-op.
 */
@Injectable()
export class RestartConfirmationService {
  private readonly logger = new Logger(RestartConfirmationService.name);

  constructor(
    @Inject(SYSTEM_META_REPOSITORY)
    private readonly meta: SystemMetaRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly restoreWorkflow: RestoreWorkflowOriginUseCase,
  ) {}

  async run(): Promise<void> {
    const reason = await this.meta.get(RESTART_REASON_KEY);
    if (!reason) return;

    const message = await this.messageFor(reason, en);
    if (message) {
      const recovery = await this.completeContextualRestart(reason);
      if (recovery === 'resumable') return;
      if (recovery === 'no-workflow') await this.broadcastToAdmins(message);
    }

    await this.meta.delete(RESTART_REASON_KEY);
    await this.meta.delete(UPDATE_COMMIT_KEY);
    await this.meta.delete(UPDATE_STATUS_KEY);
    await this.meta.delete(ROLLBACK_COMMIT_KEY);
  }

  private async completeContextualRestart(
    reason: string,
  ): Promise<'completed' | 'resumable' | 'no-workflow'> {
    const recipients = await this.users.listRecipients();
    for (const user of recipients) {
      const catalog = catalogFor(user.locale);
      const message = await this.messageFor(reason, catalog);
      if (!message) return 'no-workflow';
      const result = await this.workflows.completeHeadless({
        identity: {
          userId: user.telegramId,
          // Telegram's private-chat ID is the sender's user ID. Every
          // contextual workflow is private-chat-only, so this is the durable
          // identity used when the process comes back after a restart.
          chatId: user.telegramId,
          locale: user.locale,
          role: user.role,
          catalog,
        },
        workflow: 'system-restart',
        deliver: () => this.dm.send(user.telegramId, message),
        recoveryNotice: message,
        restore: async (receipt, notice) => {
          const restored = await this.restoreWorkflow.execute({
            userId: user.telegramId,
            chatId: user.telegramId,
            locale: user.locale,
            role: user.role,
            workflow: receipt.payload.workflow,
            requested: { kind: 'admin-system' },
            originSource: 'natural-parent',
            notice,
          });
          return restored.kind === 'opened';
        },
      });
      if (result !== 'no-workflow' && result !== 'ignored') return result;
    }
    return 'no-workflow';
  }

  private async messageFor(reason: string, catalog: LocaleCatalog): Promise<string | null> {
    switch (reason) {
      case 'user_command':
        return catalog.ota.restartComplete;
      case 'ota_update': {
        const commit = (await this.meta.get(UPDATE_COMMIT_KEY)) ?? 'unknown';
        return catalog.ota.updateSuccess(this.shortCommit(commit));
      }
      case 'ota_update_failed':
        return catalog.ota.updateFailed;
      case 'rollback': {
        const commit = (await this.meta.get(ROLLBACK_COMMIT_KEY)) ?? 'unknown';
        return catalog.ota.rollbackSuccess(this.shortCommit(commit));
      }
      case 'rollback_failed':
        return catalog.ota.rollbackFailed('see worker logs');
      default:
        this.logger.warn(`Unknown restart_reason: ${reason}`);
        return null;
    }
  }

  private async broadcastToAdmins(text: string): Promise<void> {
    const recipients = await this.users.listRecipients();
    const admins = recipients.filter((user) => user.role === 'admin');
    await Promise.all(
      admins.map((admin) =>
        this.dm.send(admin.telegramId, text).catch((err) => {
          this.logger.warn(
            `Admin notification to ${admin.telegramId} failed: ${
              (err as Error).message
            }`,
          );
        }),
      ),
    );
  }

  private shortCommit(commit: string): string {
    return commit.slice(0, 7);
  }
}
