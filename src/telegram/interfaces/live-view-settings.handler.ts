import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { ApplyLiveViewSettingsUseCase } from '../../camera/application/apply-live-view-settings.use-case';
import { GetLiveViewSettingsUseCase } from '../../camera/application/get-live-view-settings.use-case';
import { ListPrivateSubnetSuggestionsUseCase } from '../../camera/application/list-private-subnet-suggestions.use-case';
import { LiveViewRestartActivationService } from '../../camera/application/live-view-restart-activation.service';
import { LiveViewSettingsBusyError } from '../../camera/domain/errors/live-view-settings-busy.error';
import { LiveViewSettingsStateError } from '../../camera/domain/errors/live-view-settings-state.error';
import type { LiveViewSettingsCandidate } from '../../camera/domain/live-view-settings';
import type { LiveViewSettingsJob } from '../../camera/domain/live-view-settings-job';
import { LIVE_VIEW_SETTINGS_JOB_REPOSITORY, type LiveViewSettingsJobRepositoryPort } from '../../camera/domain/ports/live-view-settings-job-repository.port';
import { LIVE_STREAM_CAPABILITY, type LiveStreamCapabilityPort } from '../../camera/domain/ports/live-stream-capability.port';
import { GetFeatureDetailUseCase } from '../../features/application/get-feature-detail.use-case';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { ClaimLiveViewSettingsMutationUseCase } from '../application/claim-live-view-settings-mutation.use-case';
import { RestoreWorkflowOriginUseCase } from '../application/restore-workflow-origin.use-case';
import { DIRECT_MESSENGER, type DirectMessengerPort } from '../domain/ports/direct-messenger.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../domain/ports/user-repository.port';
import { liveViewSettingsCallback, parseLiveViewSettingsCallback, type LiveViewSettingsCallbackAction } from '../domain/live-view-settings-callback';
import { workflowReturnCallback, type WorkflowReturnReceipt } from '../domain/workflow-return';
import { LiveViewSettingsDraftRegistry, type DraftEntryResult, type LiveViewSettingsDraft } from './live-view-settings-draft.registry';
import { currentWorkflowIdentity, WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';
import { WorkflowNavigationPresenter } from './workflow-navigation.presenter';
import type { TelegramContext } from './telegram-context';
import type { TelegramHandler } from './telegram-handler';

@Injectable()
export class LiveViewSettingsHandler implements TelegramHandler {
  constructor(
    @Inject(GetLiveViewSettingsUseCase) private readonly status: GetLiveViewSettingsUseCase,
    @Inject(ListPrivateSubnetSuggestionsUseCase) private readonly suggestions: ListPrivateSubnetSuggestionsUseCase,
    @Inject(ClaimLiveViewSettingsMutationUseCase) private readonly claim: ClaimLiveViewSettingsMutationUseCase,
    @Inject(ApplyLiveViewSettingsUseCase) private readonly apply: ApplyLiveViewSettingsUseCase,
    @Inject(LiveViewRestartActivationService) private readonly restart: LiveViewRestartActivationService,
    @Inject(LIVE_VIEW_SETTINGS_JOB_REPOSITORY) private readonly jobs: LiveViewSettingsJobRepositoryPort,
    @Inject(LIVE_STREAM_CAPABILITY) private readonly capability: LiveStreamCapabilityPort,
    @Inject(GetFeatureDetailUseCase) private readonly detail: GetFeatureDetailUseCase,
    @Inject(LiveViewSettingsDraftRegistry) private readonly drafts: LiveViewSettingsDraftRegistry,
    @Inject(WorkflowEntryCoordinator) private readonly workflows: WorkflowEntryCoordinator,
    @Inject(WorkflowNavigationPresenter) private readonly navigation: WorkflowNavigationPresenter,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(DIRECT_MESSENGER) private readonly dm: DirectMessengerPort,
    @Inject(RestoreWorkflowOriginUseCase) private readonly restore: RestoreWorkflowOriginUseCase,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.callbackQuery(/^lvs:/, ctx => this.onCallback(ctx));
    composer.on('message:text', async (ctx, next) => {
      if (!await this.onText(ctx)) await next();
    });
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    if (!await this.admin(ctx)) return;
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'live-view-settings', { source: 'natural-parent' });
    if (receipt) await this.showStatus(ctx, receipt);
  }

  async onCallback(ctx: TelegramContext): Promise<void> {
    await this.acknowledge(ctx);
    if (!await this.admin(ctx)) return;
    const parsed = parseLiveViewSettingsCallback(ctx.callbackQuery?.data ?? '');
    if (!parsed) return this.stale(ctx);
    const receipt = await this.workflows.loadCurrent(ctx, parsed.receiptId, 'live-view-settings');
    if (!receipt) return this.stale(ctx);
    if (parsed.action.kind === 'retry-restart') return this.retryRestart(ctx, receipt);
    const identity = currentWorkflowIdentity(ctx)!;
    const result = this.drafts.resolve({ ...identity, receiptId: receipt.id });
    if (result.kind !== 'found') return this.stale(ctx);
    const draft = result.draft;
    if (receipt.payload.phase !== 'cancellable'
      || draft.messageId !== ctx.callbackQuery?.message?.message_id) return this.stale(ctx);
    const action = parsed.action;
    switch (action.kind) {
      case 'enable': case 'disable':
        if (draft.phase !== 'status') return this.stale(ctx);
        draft.candidate = { ...draft.candidate, enabled: action.kind === 'enable' };
        return this.review(ctx, receipt, draft);
      case 'networks': return this.networks(ctx, receipt, draft, 0);
      case 'suggestion-page': return this.networks(ctx, receipt, draft, action.page);
      case 'manual':
        draft.phase = 'manual';
        draft.pendingNormalization = null;
        return this.reply(ctx, receipt, draft, this.catalog(ctx).manualPrompt, new InlineKeyboard());
      case 'add-suggestion':
        if (draft.phase !== 'networks') return this.stale(ctx);
        return this.entryResult(ctx, receipt, draft, this.drafts.addSuggestion(draft, draft.suggestionPage, action.selector));
      case 'remove-entry':
        if (draft.phase !== 'networks') return this.stale(ctx);
        this.drafts.remove(draft, action.selector);
        return this.networks(ctx, receipt, draft, draft.suggestionPage);
      case 'confirm-normalized':
        if (draft.phase !== 'normalization') return this.stale(ctx);
        return this.entryResult(ctx, receipt, draft, this.drafts.confirmNormalization(draft));
      case 'review': return this.review(ctx, receipt, draft);
      case 'save':
        if (draft.phase !== 'review') return this.stale(ctx);
        return this.save(ctx, receipt, draft);
    }
  }

  async onText(ctx: TelegramContext): Promise<boolean> {
    const identity = currentWorkflowIdentity(ctx);
    if (!identity || !ctx.message?.text || ctx.message.text.startsWith('/')) return false;
    const associated = this.drafts.association(identity.userId, identity.chatId);
    if (!associated || !['manual', 'normalization'].includes(associated.phase)) return false;
    if (!await this.admin(ctx)) return true;
    const receipt = await this.workflows.loadCurrent(ctx, associated.receiptId, 'live-view-settings');
    const result = this.drafts.resolve({ ...identity, receiptId: associated.receiptId });
    if (receipt?.payload.phase !== 'cancellable' || result.kind !== 'found') {
      await this.stale(ctx);
      return true;
    }
    await this.entryResult(ctx, receipt, result.draft, this.drafts.addManual(result.draft, ctx.message.text));
    return true;
  }

  /** Called after boot reconciliation; delivery progress belongs to the exact durable receipt. */
  async notify(job: LiveViewSettingsJob): Promise<void> {
    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    const user = await this.users.findByTelegramId(job.requestedByUserId);
    if (!user) return;
    const catalog = catalogFor(user.locale);
    const message = job.status === 'succeeded' ? catalog.liveViewSettings.success
      : catalog.liveViewSettings.failure(catalog.liveViewSettings.failures[job.failureCode ?? 'interrupted']);
    await this.workflows.completeHeadless({
      identity: { userId: user.telegramId, chatId: job.requestedInChatId, locale: user.locale, role: user.role, catalog },
      workflow: 'live-view-settings', receiptId: job.workflowReceiptId,
      deliver: () => this.dm.send(job.requestedInChatId, message), recoveryNotice: message,
      restore: async (receipt, notice) => (await this.restore.execute({
        userId: user.telegramId, chatId: job.requestedInChatId, locale: user.locale, role: user.role,
        workflow: receipt.payload.workflow, requested: receipt.payload.origin, originSource: receipt.payload.originSource, notice,
      })).kind === 'opened',
    });
  }

  async notifyPreRestart(job: LiveViewSettingsJob): Promise<void> {
    const user = await this.users.findByTelegramId(job.requestedByUserId);
    if (user) await this.dm.send(job.requestedInChatId, catalogFor(user.locale).liveViewSettings.savedRestarting);
  }

  private async showStatus(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const catalog = this.catalog(ctx);
    const [status, active, available, rtsp] = await Promise.all([
      this.status.execute(), this.jobs.findActive(), this.capability.isAvailable('motion-mjpeg'), this.detail.execute('rtsp'),
    ]);
    const keyboard = new InlineKeyboard();
    const lines = [catalog.title];
    let draft: LiveViewSettingsDraft | null = null;
    if (status.configured && !status.repairRequired) {
      const { generation, enabled, allowedCameraCidrs } = status.configured;
      if (!active && (receipt.payload.operation?.kind !== 'live-view-settings-mutation'
        || receipt.payload.operation.expectedGeneration !== generation)) {
        const bound = await this.workflows.begin(ctx, 'live-view-settings', receipt.payload.originSource === 'captured' && receipt.sessionToken
          ? { source: 'captured', view: receipt.payload.origin, sessionToken: receipt.sessionToken }
          : { source: 'natural-parent' },
        { kind: 'live-view-settings-mutation', jobId: randomBytes(12).toString('base64url'), expectedGeneration: generation });
        if (!bound) return this.stale(ctx);
        receipt = bound;
      }
      draft = this.drafts.create({ receiptId: receipt.id, userId: receipt.userId, chatId: receipt.chatId, expectedGeneration: generation, candidate: { enabled, allowedCameraCidrs } });
      lines.push(catalog.configured(enabled ? catalog.enabled : catalog.disabled),
        catalog.active(status.restartRequired ? catalog.restartRequired : enabled ? catalog.enabled : catalog.disabled),
        catalog.generations(generation, status.bootLoadedGeneration), this.candidateSummary(catalog, draft.candidate));
      if (!active && !status.restartRequired) {
        this.button(keyboard, receipt, enabled ? catalog.disable : catalog.enable, { kind: enabled ? 'disable' : 'enable' });
        this.button(keyboard.row(), receipt, catalog.networks, { kind: 'networks' });
      }
    }
    lines.push(`${catalog.cloudflared}: ${available ? catalog.dependenciesReady : catalog.dependenciesUnavailable}`);
    if (rtsp.status.installed || rtsp.status.enabled) lines.push(`${catalog.rtsp}: ${rtsp.status.ready ? catalog.dependenciesReady : catalog.dependenciesUnavailable}`);
    lines.push(catalog.networkNote);
    if (status.migrationAttention) lines.push(catalog.legacyAttention);
    if (status.repairRequired) lines.push(catalog.repairRequired);
    if (active) lines.push(active.status === 'restart-required' ? catalog.savedRestartRequired : catalog.busy);
    if (active?.status === 'restart-required') this.button(keyboard.row(), receipt, catalog.retryRestart, { kind: 'retry-restart' });
    await this.reply(ctx, receipt, draft, lines.join('\n'), keyboard);
  }

  private async networks(ctx: TelegramContext, receipt: WorkflowReturnReceipt, draft: LiveViewSettingsDraft, page: number, notice?: string): Promise<void> {
    const catalog = this.catalog(ctx);
    const suggestions = await this.suggestions.execute(page + 1);
    draft.phase = 'networks';
    draft.pendingNormalization = null;
    draft.suggestionPage = suggestions.page - 1;
    draft.suggestions = suggestions.items;
    const keyboard = new InlineKeyboard();
    for (const suggestion of draft.suggestions) this.button(keyboard, receipt, `${suggestion.cidr} (${suggestion.interfaceLabels.join(', ')})`, { kind: 'add-suggestion', selector: Number(suggestion.selector) }).row();
    if (suggestions.page > 1) this.button(keyboard, receipt, catalog.previous, { kind: 'suggestion-page', page: suggestions.page - 2 });
    if (suggestions.page < suggestions.pageCount) this.button(keyboard, receipt, catalog.next, { kind: 'suggestion-page', page: suggestions.page });
    this.button(keyboard.row(), receipt, catalog.manual, { kind: 'manual' }).row();
    draft.candidate.allowedCameraCidrs.forEach((cidr, selector) => this.button(keyboard, receipt, catalog.remove(cidr), { kind: 'remove-entry', selector }).row());
    this.button(keyboard, receipt, catalog.review, { kind: 'review' });
    await this.reply(ctx, receipt, draft, [notice, catalog.networks, this.candidateSummary(catalog, draft.candidate), suggestions.truncated ? catalog.moreNetworks : null].filter(Boolean).join('\n'), keyboard);
  }

  private async entryResult(ctx: TelegramContext, receipt: WorkflowReturnReceipt, draft: LiveViewSettingsDraft, result: DraftEntryResult): Promise<void> {
    const catalog = this.catalog(ctx);
    if (result === 'stale') return this.stale(ctx);
    if (result === 'normalization' && draft.pendingNormalization) {
      draft.phase = 'normalization';
      const pending = draft.pendingNormalization;
      return this.reply(ctx, receipt, draft, catalog.normalization(pending.entered, pending.canonical),
        this.button(new InlineKeyboard(), receipt, catalog.confirmNormalized, { kind: 'confirm-normalized' }));
    }
    if (result === 'invalid') {
      draft.phase = 'manual';
      return this.reply(ctx, receipt, draft, catalog.invalid, new InlineKeyboard());
    }
    return this.networks(ctx, receipt, draft, draft.suggestionPage, result === 'limit' ? catalog.limit : result === 'duplicate' ? catalog.duplicate : undefined);
  }

  private async review(ctx: TelegramContext, receipt: WorkflowReturnReceipt, draft: LiveViewSettingsDraft): Promise<void> {
    const catalog = this.catalog(ctx);
    draft.pendingNormalization = null;
    const rtsp = (await this.detail.execute('rtsp')).status;
    if (draft.candidate.enabled && rtsp.installed && rtsp.enabled && draft.candidate.allowedCameraCidrs.length === 0) {
      return this.networks(ctx, receipt, draft, 0, catalog.rtspNeedsNetwork);
    }
    draft.phase = 'review';
    await this.reply(ctx, receipt, draft, `${catalog.review}\n${this.candidateSummary(catalog, draft.candidate)}\n${catalog.reviewWarning}`,
      this.button(new InlineKeyboard(), receipt, catalog.save, { kind: 'save' }));
  }

  private async save(ctx: TelegramContext, receipt: WorkflowReturnReceipt, draft: LiveViewSettingsDraft): Promise<void> {
    const operation = receipt.payload.operation;
    if (operation?.kind !== 'live-view-settings-mutation') return this.stale(ctx);
    let job: LiveViewSettingsJob;
    try {
      job = await this.claim.execute({ userId: receipt.userId, chatId: receipt.chatId, receiptId: receipt.id,
        jobId: operation.jobId, expectedGeneration: draft.expectedGeneration, candidate: draft.candidate });
    } catch (error) {
      if (error instanceof LiveViewSettingsBusyError) { await ctx.reply(this.catalog(ctx).busy); return; }
      if (error instanceof LiveViewSettingsStateError) {
        await this.drafts.cancelExact(draft);
        if (!await this.admin(ctx)) return;
        if (!await this.workflows.loadCurrent(ctx, receipt.id, 'live-view-settings')) return this.stale(ctx);
        return this.showStatus(ctx, receipt);
      }
      await ctx.reply(this.catalog(ctx).failure(this.catalog(ctx).failures['request-invalid']));
      return;
    }
    await this.drafts.cancelExact(draft);
    try { await this.reply(ctx, receipt, null, this.catalog(ctx).applying, new InlineKeyboard()); }
    finally {
      // The prepared job is durable. Navigation/update completion cannot abandon it.
      void this.runApply(ctx, receipt, job).catch(() => undefined);
    }
  }

  private async runApply(ctx: TelegramContext, receipt: WorkflowReturnReceipt, job: LiveViewSettingsJob): Promise<void> {
    try {
      const result = await this.apply.execute(job.id);
      const terminal = await this.jobs.findById(job.id);
      if (terminal?.status === 'succeeded' || terminal?.status === 'failed') { await this.notify(terminal); return; }
      const catalog = this.catalog(ctx);
      const keyboard = new InlineKeyboard();
      if (result.kind === 'restart-required') this.button(keyboard, receipt, catalog.retryRestart, { kind: 'retry-restart' });
      await this.reply(ctx, receipt, null, result.kind === 'restart-required' ? catalog.savedRestartRequired : catalog.savedRestarting, keyboard);
    } catch {
      const terminal = await this.jobs.findById(job.id);
      if (terminal?.status === 'failed' || terminal?.status === 'succeeded') await this.notify(terminal);
    }
  }

  private async retryRestart(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const job = await this.jobs.findActive();
    const operation = receipt.payload.operation;
    if (job?.status !== 'restart-required' || (operation?.kind === 'live-view-settings-mutation' && operation.jobId !== job.id)) return this.stale(ctx);
    const catalog = this.catalog(ctx);
    try {
      await this.restart.retry(job.id);
      await this.reply(ctx, receipt, null, catalog.savedRestarting, new InlineKeyboard());
    } catch {
      await this.reply(ctx, receipt, null, catalog.savedRestartRequired, this.button(new InlineKeyboard(), receipt, catalog.retryRestart, { kind: 'retry-restart' }));
    }
  }

  private async admin(ctx: TelegramContext): Promise<boolean> {
    const identity = currentWorkflowIdentity(ctx);
    if (!identity) return false;
    const user = await this.users.findByTelegramId(identity.userId);
    if (user?.role === 'admin') return true;
    this.drafts.cancelUser(identity.userId);
    await ctx.reply(identity.catalog.common.adminRequired);
    return false;
  }

  private async acknowledge(ctx: TelegramContext): Promise<void> {
    if (ctx.homeCallbackAcknowledged) return;
    ctx.homeCallbackAcknowledged = true;
    await ctx.answerCallbackQuery().catch(() => undefined);
  }

  private async stale(ctx: TelegramContext): Promise<void> { await ctx.reply(this.catalog(ctx).startAgain); }
  private catalog(ctx: TelegramContext): LocaleCatalog['liveViewSettings'] { return ctx.localeState!.catalog.liveViewSettings; }
  private candidateSummary(catalog: LocaleCatalog['liveViewSettings'], candidate: LiveViewSettingsCandidate): string {
    return `${candidate.enabled ? catalog.enabled : catalog.disabled}\n${candidate.allowedCameraCidrs.join('\n') || catalog.none}`;
  }
  private button(keyboard: InlineKeyboard, receipt: WorkflowReturnReceipt, label: string, action: LiveViewSettingsCallbackAction): InlineKeyboard {
    return keyboard.text(label, liveViewSettingsCallback(receipt.id, action));
  }
  private async reply(ctx: TelegramContext, receipt: WorkflowReturnReceipt, draft: LiveViewSettingsDraft | null, text: string, keyboard: InlineKeyboard): Promise<void> {
    const catalog = ctx.localeState!.catalog;
    if (draft && draft.phase !== 'status') keyboard.row().text(catalog.liveViewSettings.cancel, workflowReturnCallback(receipt.id, 'origin'));
    this.navigation.appendExitRow(keyboard, receipt, { origin: catalog.home.navigation.backTo['admin-tools'], home: catalog.home.workflow.home });
    const message = await ctx.reply(text, { reply_markup: keyboard });
    if (draft) draft.messageId = message.message_id;
  }
}
