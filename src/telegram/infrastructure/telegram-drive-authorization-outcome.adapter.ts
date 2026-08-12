import { Inject, Injectable } from '@nestjs/common';
import { catalogFor, type LocaleCatalog } from '../../locales';
import type {
  DriveAuthorizationFailureReason,
  DriveAuthorizationOutcome,
  DriveAuthorizationOutcomePort,
} from '../../archive/application/ports/drive-authorization-outcome.port';
import { RestoreWorkflowOriginUseCase } from '../application/restore-workflow-origin.use-case';
import { DIRECT_MESSENGER, type DirectMessengerPort } from '../domain/ports/direct-messenger.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../domain/ports/user-repository.port';
import { DriveSetupStateRegistry } from '../interfaces/drive-setup-state.registry';
import { WorkflowEntryCoordinator } from '../interfaces/workflow-entry.coordinator';

/** Delivers device-code outcomes without exposing device codes, tokens, or client material. */
@Injectable()
export class TelegramDriveAuthorizationOutcomeAdapter implements DriveAuthorizationOutcomePort {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly messenger: DirectMessengerPort,
    private readonly setupStates: DriveSetupStateRegistry,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly restoreWorkflow: RestoreWorkflowOriginUseCase,
  ) {}

  async publish(outcome: DriveAuthorizationOutcome): Promise<void> {
    const user = await this.users.findByTelegramId(outcome.adminUserId);
    if (user?.role !== 'admin') return;
    const catalog = catalogFor(user.locale);
    const binding = {
      userId: outcome.adminUserId,
      chatId: outcome.chatId,
      receiptId: outcome.receiptId,
      generationId: outcome.generationId,
    };
    if (outcome.kind === 'authorized') {
      if (!this.setupStates.observeAuthorized(binding)) return;
      const account = outcome.account.displayName ?? outcome.account.email ?? catalog.gdriveConnection.accountUnavailable;
      await this.messenger.send(outcome.adminUserId, catalog.gdriveConnection.authorizationReady(account));
      return;
    }
    if (!this.setupStates.takeTerminal(binding)) return;
    const message = messageFor(outcome.reason, catalog);
    await this.workflows.completeHeadless({
      identity: {
        userId: user.telegramId,
        chatId: outcome.chatId,
        locale: user.locale,
        role: user.role,
        catalog,
      },
      workflow: 'drive-setup',
      receiptId: outcome.receiptId,
      deliver: () => this.messenger.send(user.telegramId, message),
      recoveryNotice: message,
      restore: async (receipt, notice) => (await this.restoreWorkflow.execute({
        userId: user.telegramId,
        chatId: outcome.chatId,
        locale: user.locale,
        role: user.role,
        workflow: receipt.payload.workflow,
        requested: receipt.payload.origin,
        originSource: receipt.payload.originSource,
        notice,
      })).kind === 'opened',
    });
  }
}

function messageFor(reason: DriveAuthorizationFailureReason, catalog: LocaleCatalog): string {
  switch (reason) {
    case 'denied': return catalog.gdriveConnection.authorizationFailed;
    case 'expired': return catalog.gdriveConnection.setupExpired;
    case 'policy': return catalog.gdriveConnection.policyBlocked;
    case 'rate-limited': return catalog.gdriveConnection.rateLimited;
    case 'client-rejected': return catalog.gdriveConnection.clientRejected;
    case 'provider-response': return catalog.gdriveConnection.providerResponse;
    case 'unavailable': return catalog.gdriveConnection.temporaryUnavailable;
  }
}
