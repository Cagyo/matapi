import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { BeginFeatureInstallUseCase } from '../../features/application/begin-feature-install.use-case';
import { DisableFeatureUseCase } from '../../features/application/disable-feature.use-case';
import { EnableFeatureUseCase } from '../../features/application/enable-feature.use-case';
import { GetFeatureDetailUseCase, type FeatureDetail } from '../../features/application/get-feature-detail.use-case';
import { ListManageableFeaturesUseCase } from '../../features/application/list-manageable-features.use-case';
import { VerifyFeatureReadinessUseCase } from '../../features/application/verify-feature-readiness.use-case';
import type { FeatureStatus } from '../../features/domain/feature-status';
import type { FeatureInstallJob, ManageableFeatureName } from '../../features/domain/manageable-feature';
import { FeatureInstallBusyError } from '../../features/domain/errors/feature-install-busy.error';
import { FeatureInstallStartError } from '../../features/domain/errors/feature-install-start.error';
import { FeatureNotInstalledError } from '../../features/domain/errors/feature-not-installed.error';
import { FeatureInconsistentError } from '../../features/domain/errors/feature-inconsistent.error';
import { FeatureAlreadyEnabledError } from '../../features/domain/errors/feature-already-enabled.error';
import { FeatureAlreadyDisabledError } from '../../features/domain/errors/feature-already-disabled.error';
import { FeatureRestartDispatchError } from '../../features/domain/errors/feature-restart-dispatch.error';
import { FeatureStateChangedError } from '../../features/domain/errors/feature-state-changed.error';
import { FeatureVerificationError } from '../../features/domain/errors/feature-verification.error';
import { UnknownFeatureError } from '../../features/domain/errors/unknown-feature.error';
import {
  FEATURE_INSTALL_OUTCOME_REGISTRY,
  type FeatureInstallOutcomePort,
  type FeatureInstallOutcomeRegistryPort,
} from '../../features/domain/ports/feature-install-outcome.port';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { ClaimFeatureMutationUseCase } from '../application/claim-feature-mutation.use-case';
import { RestoreWorkflowOriginUseCase } from '../application/restore-workflow-origin.use-case';
import { DIRECT_MESSENGER, type DirectMessengerPort } from '../domain/ports/direct-messenger.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../domain/ports/user-repository.port';
import type { FeatureWorkflowOperation, WorkflowReturnReceipt } from '../domain/workflow-return';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import { currentWorkflowIdentity, type WorkflowLaunch, WorkflowEntryCoordinator } from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

const FEATURE_CALLBACK = /^ft:(l|d|c|v):([A-Za-z0-9_-]{16})(?::([duzmr]))?$/;
const FEATURE_CODES: Record<string, ManageableFeatureName> = {
  d: 'digital', u: 'uart', z: 'zigbee', m: 'motion', r: 'rtsp',
};
const FEATURE_CODE: Record<ManageableFeatureName, string> = {
  digital: 'd', uart: 'u', zigbee: 'z', motion: 'm', rtsp: 'r',
};

/** Receipt-bound, localized feature navigation. Feature state remains in the feature module. */
@Injectable()
export class FeatureHandler implements TelegramHandler, FeatureInstallOutcomePort {
  private readonly logger = new Logger(FeatureHandler.name);
  constructor(
    private readonly list: ListManageableFeaturesUseCase,
    private readonly detail: GetFeatureDetailUseCase,
    private readonly install: BeginFeatureInstallUseCase,
    private readonly enable: EnableFeatureUseCase,
    private readonly disable: DisableFeatureUseCase,
    private readonly verify: VerifyFeatureReadinessUseCase,
    private readonly claim: ClaimFeatureMutationUseCase,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly navigation: WorkflowNavigationHandler,
    private readonly restoreWorkflow: RestoreWorkflowOriginUseCase,
    @Inject(FEATURE_INSTALL_OUTCOME_REGISTRY)
    private readonly outcomes: FeatureInstallOutcomeRegistryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    // Gateway registration happens after locale resolution, so recovered
    // install outcomes always render with the recipient's persisted locale.
    this.outcomes.register(this);
    composer.command('feature', this.guard.adminOnly, async (ctx) => {
      const args = String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const [subcommand, name] = args;
      if (subcommand === 'list' && args.length === 1) return this.handleList(ctx);
      if ((subcommand === 'install' || subcommand === 'enable' || subcommand === 'disable') && args.length === 2 && name) {
        const receipt = await this.beginList(ctx);
        if (!receipt) return;
        // Command verbs express navigation intent only; current state chooses the operation.
        return this.openDetail(ctx, receipt, name);
      }
      await ctx.reply(ctx.localeState!.catalog.feature.usage);
    });
    composer.callbackQuery(FEATURE_CALLBACK, this.guard.registered, async (ctx) => {
      await this.acknowledge(ctx);
      await this.handleCallback(ctx);
    });
  }

  async handleList(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.beginList(ctx);
    if (!receipt) return;
    try {
      const features = await this.list.execute();
      const catalog = ctx.localeState!.catalog.feature;
      const keyboard = new InlineKeyboard();
      for (const feature of features) {
        keyboard.text(catalog.listButton(catalog.names[feature.name], catalog.state[feature.display]), callback('d', receipt.id, FEATURE_CODE[feature.name])).row();
      }
      keyboard.text(ctx.localeState!.catalog.home.workflow.home, `wr:${receipt.id}:h`);
      await ctx.reply(catalog.listHeader, { reply_markup: keyboard });
    } catch {
      await ctx.reply(ctx.localeState!.catalog.feature.listFailed);
    }
  }

  async notify(job: FeatureInstallJob): Promise<void> {
    const user = await this.users.findByTelegramId(job.requestedByUserId);
    if (!user) return;
    const catalog = catalogFor(user.locale);
    const name = catalog.feature.names[job.feature];
    let final: FeatureDetail;
    try {
      final = await this.detail.execute(job.feature);
    } catch {
      // The terminal job remains retryable: without an authoritative current
      // feature projection we must not turn success into a guessed failure.
      this.logger.warn(`Feature install outcome detail unavailable for ${job.feature}`);
      return;
    }
    const succeeded = job.status === 'succeeded' && final.status.attentionReason === null;
    const message = succeeded
      ? catalog.feature.outcome.success(name)
      : catalog.feature.outcome.failure(name, failureLabel(catalog.feature, job.failureCode, final.status.attentionReason));
    await this.workflows.completeHeadless({
      identity: { userId: user.telegramId, chatId: job.requestedInChatId, locale: user.locale, role: user.role, catalog },
      workflow: 'feature',
      receiptId: job.workflowReceiptId,
      deliver: () => this.dm.send(job.requestedInChatId, message),
      recoveryNotice: succeeded
        ? catalog.feature.outcome.recoveredSuccess(name)
        : catalog.feature.outcome.recoveredFailure(name, failureLabel(catalog.feature, job.failureCode, final.status.attentionReason)),
      restore: async (receipt, notice) => (await this.restoreWorkflow.execute({
        userId: user.telegramId,
        chatId: job.requestedInChatId,
        locale: user.locale,
        role: user.role,
        workflow: receipt.payload.workflow,
        requested: receipt.payload.origin,
        originSource: receipt.payload.originSource,
        notice,
      })).kind === 'opened',
    });
  }

  async notifyPreRestart(job: FeatureInstallJob): Promise<void> {
    const user = await this.users.findByTelegramId(job.requestedByUserId);
    if (!user) return;
    const catalog = catalogFor(user.locale);
    const scope = job.restartScope ?? 'worker';
    await this.dm.send(job.requestedInChatId, catalog.feature.preRestart(
      catalog.feature.names[job.feature], catalog.feature.restartScope[scope],
    ));
  }

  private async handleCallback(ctx: TelegramContext): Promise<void> {
    const parsed = parseCallback(ctx.callbackQuery?.data ?? '');
    const identity = currentWorkflowIdentity(ctx);
    if (!parsed || !identity || identity.role !== 'admin') return this.stale(ctx);
    if (parsed.kind === 'd') {
      const current = await this.workflows.loadCurrent(ctx, parsed.receiptId, 'feature');
      if (!current || !parsed.feature) return this.stale(ctx);
      return this.openDetail(ctx, current, parsed.feature);
    }
    if (parsed.kind === 'l') {
      const current = await this.workflows.loadCurrent(ctx, parsed.receiptId, 'feature');
      return current ? this.handleList(ctx, { receipt: current }) : this.stale(ctx);
    }
    return this.confirm(ctx, parsed.receiptId, parsed.kind === 'v');
  }

  private async openDetail(ctx: TelegramContext, listReceipt: WorkflowReturnReceipt, name: string): Promise<void> {
    let detail: FeatureDetail;
    try {
      detail = await this.detail.execute(name);
    } catch (error) {
      if (error instanceof UnknownFeatureError) {
        await ctx.reply(ctx.localeState!.catalog.feature.unknown(name));
        return;
      }
      await ctx.reply(ctx.localeState!.catalog.feature.listFailed);
      return;
    }
    const operation = operationFor(detail.status);
    if (!operation) {
      await this.replyDetail(ctx, listReceipt, detail, null);
      return;
    }
    const receipt = await this.workflows.begin(ctx, 'feature', workflowOrigin(listReceipt), operation);
    if (!receipt) return this.stale(ctx);
    await this.replyDetail(ctx, receipt, detail, operation.action);
  }

  private async replyDetail(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    detail: FeatureDetail,
    action: FeatureWorkflowOperation['action'] | null,
  ): Promise<void> {
    const catalog = ctx.localeState!.catalog.feature;
    const name = catalog.names[detail.status.name];
    const text = catalog.detail({
      name,
      description: catalog.description[detail.status.name],
      state: catalog.state[detail.status.display],
      dependencies: catalog.impact.dependencies[detail.impact.dependencies],
      controls: catalog.impact.controls[detail.impact.controls],
      monitoring: catalog.impact.monitoring[detail.impact.monitoring],
      downtime: catalog.downtime[detail.impact.restartScope],
      attention: detail.status.attentionReason ? catalog.attention[detail.status.attentionReason] : null,
    });
    const keyboard = new InlineKeyboard();
    if (action) {
      const button = action === 'verify' ? callback('v', receipt.id) : callback('c', receipt.id);
      keyboard.text(catalog.confirmation[action](name, catalog.restartScope[detail.impact.restartScope]), button).row();
    }
    keyboard.text(catalog.listBack, callback('l', receipt.id)).row();
    keyboard.text(ctx.localeState!.catalog.home.common.back, `wr:${receipt.id}:o`)
      .text(ctx.localeState!.catalog.home.workflow.home, `wr:${receipt.id}:h`);
    await ctx.reply(text, { reply_markup: keyboard });
  }

  private async confirm(ctx: TelegramContext, receiptId: string, verifyOnly: boolean): Promise<void> {
    const claimed = await this.claim.execute({ userId: ctx.from!.id, chatId: ctx.chat!.id, id: receiptId });
    if (claimed.kind !== 'claimed' || (verifyOnly ? claimed.operation.action !== 'verify' : claimed.operation.action === 'verify')) {
      return this.stale(ctx);
    }
    const { operation, receipt } = claimed;
    const catalog = ctx.localeState!.catalog.feature;
    const name = catalog.names[operation.feature];
    try {
      if (operation.action === 'install') {
        await this.install.execute({
          id: receipt.id, feature: operation.feature, requestedByUserId: receipt.userId,
          requestedInChatId: receipt.chatId, workflowReceiptId: receipt.id,
          expected: { installed: false, enabled: false },
        });
        await ctx.reply(catalog.progress.installing(name));
        return;
      }
      if (operation.action === 'enable') {
        await this.enable.execute({ name: operation.feature, expected: expected(operation) });
      } else if (operation.action === 'disable') {
        await this.disable.execute({ name: operation.feature, expected: expected(operation) });
      } else {
        await this.verify.execute({ name: operation.feature, source: 'manual', expected: expected(operation) });
      }
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await ctx.reply(catalog.outcome.success(name)); },
        failureNotice: catalog.recovery.unavailable,
      });
    } catch (error) {
      if (error instanceof FeatureStateChangedError) {
        await this.openDetail(ctx, receipt, operation.feature);
        return;
      }
      const message = this.failure(catalog, operation, error);
      if (!isExpectedFeatureError(error)) {
        this.logger.error(`Feature ${operation.action} failed for ${operation.feature}`);
      }
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await ctx.reply(message); },
        failureNotice: catalog.recovery.unavailable,
      });
    }
  }

  private failure(catalog: LocaleCatalog['feature'], operation: FeatureWorkflowOperation, error: unknown): string {
    const name = catalog.names[operation.feature];
    if (error instanceof FeatureInstallBusyError) return catalog.busy(catalog.names[error.activeFeature]);
    if (error instanceof FeatureInstallStartError) return catalog.errors.installStart(name);
    if (error instanceof FeatureNotInstalledError) return catalog.errors.notInstalled(name);
    if (error instanceof FeatureInconsistentError) return catalog.errors.inconsistent(name);
    if (error instanceof FeatureAlreadyEnabledError) return catalog.errors.alreadyEnabled(name);
    if (error instanceof FeatureAlreadyDisabledError) return catalog.errors.alreadyDisabled(name);
    if (error instanceof FeatureRestartDispatchError) return catalog.errors.restartFailed(name, catalog.restartScope[error.scope]);
    if (error instanceof FeatureStateChangedError) return catalog.recovery.stale;
    if (error instanceof FeatureVerificationError) return catalog.verificationFailed(name);
    if (error instanceof UnknownFeatureError) return catalog.unknown(name);
    return catalog.outcome.genericFailure(name);
  }

  private async beginList(ctx: TelegramContext): Promise<WorkflowReturnReceipt | null> {
    return this.workflows.begin(ctx, 'feature', { source: 'natural-parent' });
  }

  private async stale(ctx: TelegramContext): Promise<void> {
    await ctx.reply(ctx.localeState!.catalog.feature.recovery.stale);
  }

  private async acknowledge(ctx: TelegramContext): Promise<void> {
    if (ctx.homeCallbackAcknowledged) return;
    await ctx.answerCallbackQuery().catch(() => undefined);
    ctx.homeCallbackAcknowledged = true;
  }
}

function callback(kind: 'l' | 'd' | 'c' | 'v', receiptId: string, code?: string): string {
  const data = kind === 'd' ? `ft:d:${receiptId}:${code}` : `ft:${kind}:${receiptId}`;
  if (Buffer.byteLength(data, 'utf8') > 64) throw new RangeError('Feature callback exceeds Telegram callback-data limit');
  return data;
}

function parseCallback(data: string): { kind: 'l' | 'd' | 'c' | 'v'; receiptId: string; feature?: ManageableFeatureName } | null {
  if (Buffer.byteLength(data, 'utf8') > 64) return null;
  const match = FEATURE_CALLBACK.exec(data);
  if (!match) return null;
  const kind = match[1] as 'l' | 'd' | 'c' | 'v';
  if ((kind === 'd') !== Boolean(match[3])) return null;
  const feature = match[3] ? FEATURE_CODES[match[3]] : undefined;
  return kind === 'd' && !feature ? null : { kind, receiptId: match[2], feature };
}

function operationFor(status: FeatureStatus): FeatureWorkflowOperation | null {
  if (!status.action) return null;
  return {
    kind: 'feature-mutation', feature: status.name, action: status.action,
    expectedInstalled: status.installed, expectedEnabled: status.enabled,
    expectedAttentionReason: status.attentionReason as FeatureWorkflowOperation['expectedAttentionReason'],
  };
}

function expected(operation: FeatureWorkflowOperation) {
  return {
    installed: operation.expectedInstalled,
    enabled: operation.expectedEnabled,
    attentionReason: operation.expectedAttentionReason,
  };
}

function workflowOrigin(receipt: WorkflowReturnReceipt) {
  return receipt.payload.originSource === 'captured' && receipt.sessionToken
    ? { source: 'captured' as const, view: receipt.payload.origin, sessionToken: receipt.sessionToken }
    : { source: 'natural-parent' as const };
}

function isExpectedFeatureError(error: unknown): boolean {
  return error instanceof FeatureInstallBusyError
    || error instanceof FeatureStateChangedError
    || error instanceof FeatureVerificationError
    || error instanceof FeatureInstallStartError
    || error instanceof FeatureNotInstalledError
    || error instanceof FeatureInconsistentError
    || error instanceof FeatureAlreadyEnabledError
    || error instanceof FeatureAlreadyDisabledError
    || error instanceof FeatureRestartDispatchError
    || error instanceof UnknownFeatureError;
}

function failureLabel(
  catalog: LocaleCatalog['feature'],
  failureCode: FeatureInstallJob['failureCode'],
  attention: FeatureStatus['attentionReason'] | undefined,
): string {
  if (attention) return catalog.attention[attention];
  return catalog.failure[failureCode ?? 'interrupted'];
}
