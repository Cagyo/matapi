import { Injectable, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { HomeNavigationUseCase } from '../application/home-navigation.use-case';
import { OpenHomeUseCase } from '../application/open-home.use-case';
import { RefreshHomeMonitoringUseCase } from '../application/refresh-home-monitoring.use-case';
import { RenderHomeUseCase, type RenderHomeResult } from '../application/render-home.use-case';
import { ValidateHomeCallbackUseCase } from '../application/validate-home-callback.use-case';
import type { HomeView } from '../domain/home-session';
import { OPEN_NEW_HOME_CALLBACK, parseHomeCallback } from '../domain/home-callback';
import { CameraHandler } from './camera.handler';
import { LogsHandler } from './logs.handler';
import { CsvHandler } from './csv.handler';
import { SettingsHandler } from './settings.handler';
import { HelpHandler } from './help.handler';
import { ConfigHandler } from './config.handler';
import { GdriveHandler } from './gdrive.handler';
import { GdriveAuthHandler } from './gdrive-auth.handler';
import { HealthHandler } from './health.handler';
import { InviteHandler } from './invite.handler';
import { ImportConfigHandler } from './import-config.handler';
import { ExportConfigHandler } from './export-config.handler';
import { SystemUpdateHandler } from './system-update.handler';
import { TriggerCleanUseCase } from '../../camera/application/trigger-clean.use-case';
import { RestartSystemUseCase } from '../application/restart-system.use-case';
import { SetAutoCleanThresholdUseCase } from '../application/set-auto-clean-threshold.use-case';
import { SetNotificationTargetMutedUseCase } from '../application/set-notification-target-muted.use-case';
import { HOME_ACTION_REPOSITORY, type HomeActionRepositoryPort } from '../application/ports/home-action-repository.port';
import { Inject } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext, type LocaleState } from './telegram-context';
import { TelegramHandler } from './telegram-handler';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';

@Injectable()
export class HomeHandler implements TelegramHandler {
  constructor(
    private readonly guard: RoleMiddleware,
    private readonly openHome: OpenHomeUseCase,
    private readonly validateCallback: ValidateHomeCallbackUseCase,
    private readonly renderHome: RenderHomeUseCase,
    private readonly refreshMonitoring: RefreshHomeMonitoringUseCase,
    private readonly camera: CameraHandler,
    private readonly navigation?: HomeNavigationUseCase,
    private readonly logs?: LogsHandler,
    private readonly csv?: CsvHandler,
    private readonly settings?: SettingsHandler,
    private readonly help?: HelpHandler,
    private readonly config?: ConfigHandler,
    private readonly drive?: GdriveHandler,
    private readonly driveAuth?: GdriveAuthHandler,
    private readonly health?: HealthHandler,
    private readonly invite?: InviteHandler,
    private readonly importConfig?: ImportConfigHandler,
    private readonly exportConfig?: ExportConfigHandler,
    private readonly systemUpdate?: SystemUpdateHandler,
    private readonly clean?: TriggerCleanUseCase,
    private readonly restart?: RestartSystemUseCase,
    private readonly thresholds?: SetAutoCleanThresholdUseCase,
    private readonly targetMute?: SetNotificationTargetMutedUseCase,
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions?: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock?: ClockPort,
    @Optional() private readonly workflows?: WorkflowEntryCoordinator,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('menu', this.guard.registered, async (ctx) => {
      await this.open(ctx);
    });
    composer.callbackQuery(/^(?:h:|ho$)/, this.guard.registered, async (ctx) => {
      await this.handleCallback(ctx);
    });
  }

  private async open(ctx: TelegramContext): Promise<'opened' | 'not-opened'> {
    const current = this.current(ctx);
    if (!current) return 'not-opened';
    const destination: HomeView = { kind: 'home', checking: false };
    try {
      const leave = await this.leaveForHome(ctx, () => this.openFresh(current, destination));
      if (leave === 'opened') return 'opened';
      if (leave === 'no-workflow') return await this.openFresh(current, destination) ? 'opened' : 'not-opened';
      await this.recover(ctx, leave === 'stale' ? 'stale' : 'unavailable');
      return 'not-opened';
    } catch {
      await this.recover(ctx, 'unavailable');
      return 'not-opened';
    }
  }

  private async handleCallback(ctx: TelegramContext): Promise<void> {
    const current = this.current(ctx);
    if (!current) return;
    const data = ctx.callbackQuery?.data;
    if (data === OPEN_NEW_HOME_CALLBACK) {
      const result = await this.open(ctx);
      if (result === 'opened') await this.deleteCallbackMessageWithoutFailing(ctx);
      return;
    }

    const parsed = data ? parseHomeCallback(data) : null;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!parsed || !messageId) {
      await this.recover(ctx, 'stale');
      return;
    }

    let verdict: Awaited<ReturnType<ValidateHomeCallbackUseCase['execute']>>;
    try {
      verdict = await this.validateCallback.execute({
        parsed,
        userId: current.userId,
        chatId: current.chatId,
        messageId,
      });
    } catch {
      await this.recover(ctx, 'unavailable');
      return;
    }
    if (verdict.kind === 'updating') {
      await this.recover(ctx, 'updating');
      return;
    }
    if (verdict.kind !== 'accepted') {
      await this.recover(ctx, 'stale');
      return;
    }

    try {
      if (parsed.action.kind === 'check') { await this.check(ctx, verdict.active, verdict.view); return; }
      await this.navigate(ctx, verdict.active, verdict.view, parsed.action);
    } catch {
      await this.recover(ctx, 'unavailable');
    }
  }

  private async navigate(
    ctx: TelegramContext,
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    view: HomeView,
    action: Extract<ReturnType<typeof parseHomeCallback>, { action: unknown }>['action'],
  ): Promise<void> {
    if (!this.navigation) {
      await this.recover(ctx, 'unavailable');
      return;
    }
    const result = await this.navigation.execute({ active, role: ctx.localeState!.user.role, view, action });
    if (result.kind === 'recovery') {
      if (result.reason === 'executing') {
        await ctx.reply(action.kind === 'confirm-restart'
          ? ctx.localeState!.catalog.ota.restarting
          : ctx.localeState!.catalog.home.cleanupResult.inProgress);
      } else await this.recover(ctx, 'stale');
      return;
    }
    if (result.kind === 'external') { await this.external(ctx, result.destination, active, view); return; }
    if (result.kind === 'restart') { await this.restartClaimed(ctx, active, action); return; }
    if (action.kind === 'confirm-cleanup' && result.view.kind === 'cleanup-result') { await this.cleanupClaimed(ctx, active, action.receiptId); return; }
    if (action.kind === 'auto-clean-threshold' && this.thresholds) await this.thresholds.execute(action.value);
    if ((action.kind === 'notification-target-mute' || action.kind === 'notification-target-unmute') && view.kind === 'notification-target' && this.targetMute) {
      await this.targetMute.execute(active.userId, view.target, action.kind === 'notification-target-mute');
    }
    const leave = await this.leaveForHome(ctx, () => this.openFreshFromContext(ctx, result.view));
    if (leave === 'opened') return;
    if (leave === 'no-workflow') {
      await this.render(ctx, active, result.view);
      return;
    }
    await this.recover(ctx, leave === 'stale' ? 'stale' : 'unavailable');
  }

  private async cleanupClaimed(ctx: TelegramContext, active: Parameters<RenderHomeUseCase['execute']>[0]['active'], id: string): Promise<void> {
    if (!this.clean || !this.actions) { await this.recover(ctx, 'unavailable'); return; }
    try {
      const outcome = await this.clean.execute();
      await this.actions.finishExternal({ action: { id, userId: active.userId, chatId: active.chatId, kind: 'cleanup-confirmation' }, outcome: 'completed', now: this.clock!.now() });
      await this.render(ctx, active, { kind: 'cleanup-result', outcome: outcome.executed ? 'executed' : 'in-progress', threshold: outcome.thresholdUsed || null });
    } catch {
      await this.actions.finishExternal({ action: { id, userId: active.userId, chatId: active.chatId, kind: 'cleanup-confirmation' }, outcome: 'failed', now: this.clock!.now() });
      await this.render(ctx, active, { kind: 'cleanup-result', outcome: 'failed', threshold: null });
    }
  }

  private async restartClaimed(ctx: TelegramContext, active: Parameters<RenderHomeUseCase['execute']>[0]['active'], action: Extract<ReturnType<typeof parseHomeCallback>, { action: unknown }>['action']): Promise<void> {
    if (action.kind !== 'confirm-restart' || !this.restart || !this.actions) { await this.recover(ctx, 'unavailable'); return; }
    try {
      await ctx.reply(ctx.localeState!.catalog.ota.restarting);
      await this.restart.execute();
      await this.actions.finishExternal({ action: { id: action.receiptId, userId: active.userId, chatId: active.chatId, kind: 'restart-confirmation' }, outcome: 'completed', now: this.clock!.now() });
    } catch (error) {
      await this.actions.finishExternal({ action: { id: action.receiptId, userId: active.userId, chatId: active.chatId, kind: 'restart-confirmation' }, outcome: 'failed', now: this.clock!.now() });
      await ctx.reply(ctx.localeState!.catalog.ota.restartFailed(error instanceof Error ? error.message : 'unknown'));
    }
  }

  private async external(
    ctx: TelegramContext,
    destination: Extract<Awaited<ReturnType<HomeNavigationUseCase['execute']>>, { kind: 'external' }>['destination'],
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    view: HomeView,
  ): Promise<void> {
    switch (destination) {
      case 'camera': {
        const launch = await this.beginCameraWorkflow(ctx, active, view);
        if (!launch) return this.recover(ctx, 'unavailable');
        return this.camera.handleDashboard(ctx, launch);
      }
      case 'history-logs': return this.logs ? this.logs.handleEmpty(ctx) : this.recover(ctx, 'unavailable');
      case 'history-csv': return this.csv ? this.csv.handleEmpty(ctx, 'menu') : this.recover(ctx, 'unavailable');
      case 'settings': return this.settings ? this.settings.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      case 'help':
        if (!this.help) return this.recover(ctx, 'unavailable');
        await ctx.reply(ctx.localeState!.user.role === 'admin' ? ctx.localeState!.catalog.help.admin : ctx.localeState!.catalog.help.user);
        return;
      case 'config-add': case 'config-modify': case 'config-remove': return this.config ? this.config.handleSubcommand(ctx, destination.slice('config-'.length)) : this.recover(ctx, 'unavailable');
      case 'config-import': return this.importConfig ? this.importConfig.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      case 'config-export': return this.exportConfig ? this.exportConfig.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      case 'drive-status': return this.drive ? this.drive.handleStatus(ctx, { includeCleanupAction: false }) : this.recover(ctx, 'unavailable');
      case 'drive-connect': return this.driveAuth ? this.driveAuth.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      case 'system-health': return this.health ? this.health.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      case 'system-packages': return this.systemUpdate ? this.systemUpdate.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      case 'invite': return this.invite ? this.invite.handleCommand(ctx) : this.recover(ctx, 'unavailable');
      default: return this.recover(ctx, 'unavailable');
    }
  }

  private async check(
    ctx: TelegramContext,
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    acceptedView: HomeView,
  ): Promise<void> {
    if (acceptedView.kind !== 'home' && acceptedView.kind !== 'sensors') {
      await this.recover(ctx, 'stale');
      return;
    }
    const checking = await this.renderHome.execute({
      active,
      ...this.renderOptions(ctx),
      view: { ...acceptedView, checking: true },
    });
    if (!this.isRendered(checking)) {
      await this.recoverRenderFailure(ctx, checking);
      return;
    }
    if (checking.view.kind !== 'home' && checking.view.kind !== 'sensors') {
      await this.recover(ctx, 'unavailable');
      return;
    }

    try {
      await this.refreshMonitoring.execute();
    } catch {
      // Keep the Home interaction coherent even if an infrastructure adapter
      // violates the refresh use case's normal failure-as-result contract.
    }

    const complete = await this.renderHome.execute({
      active: checking.active,
      ...this.renderOptions(ctx),
      view: { ...checking.view, checking: false },
    });
    if (!this.isRendered(complete)) await this.recoverRenderFailure(ctx, complete);
  }

  private async render(
    ctx: TelegramContext,
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    view: HomeView,
  ): Promise<void> {
    const result = await this.renderHome.execute({ active, ...this.renderOptions(ctx), view });
    if (!this.isRendered(result)) await this.recoverRenderFailure(ctx, result);
  }

  private async leaveForHome(
    ctx: TelegramContext,
    promote: () => Promise<boolean>,
  ): Promise<'opened' | 'no-workflow' | 'not-opened' | 'stale'> {
    if (!this.workflows) return 'no-workflow';
    const result = await this.workflows.leaveForHome(ctx, promote);
    return result === 'ignored' ? 'not-opened' : result;
  }

  private async beginCameraWorkflow(
    ctx: TelegramContext,
    active: Parameters<RenderHomeUseCase['execute']>[0]['active'],
    view: HomeView,
  ): Promise<WorkflowLaunch | null> {
    if (!this.workflows) return null;
    const receipt = await this.workflows.begin(ctx, 'camera', {
      source: 'captured',
      view,
      sessionToken: active.token,
    });
    return receipt ? { receipt } : null;
  }

  private async openFresh(
    current: NonNullable<ReturnType<HomeHandler['current']>>,
    view: HomeView,
  ): Promise<boolean> {
    const result = await this.openHome.execute({
      userId: current.userId,
      chatId: current.chatId,
      locale: current.state.locale,
      role: current.state.user.role,
      view,
    });
    return result.kind === 'opened';
  }

  private async openFreshFromContext(ctx: TelegramContext, view: HomeView): Promise<boolean> {
    const current = this.current(ctx);
    return current ? this.openFresh(current, view) : false;
  }

  private renderOptions(ctx: TelegramContext): Pick<Parameters<RenderHomeUseCase['execute']>[0], 'locale' | 'role'> {
    const state = ctx.localeState!;
    return { locale: state.locale, role: state.user.role };
  }

  private isRendered(result: RenderHomeResult): result is Extract<RenderHomeResult, { active: unknown }> {
    return result.kind === 'rendered' || result.kind === 'reopened';
  }

  private async recoverRenderFailure(ctx: TelegramContext, result: RenderHomeResult): Promise<void> {
    await this.recover(ctx, result.kind === 'delivery_failed' ? 'unavailable' : 'stale');
  }

  private async recover(
    ctx: TelegramContext,
    reason: 'stale' | 'updating' | 'unavailable',
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog;
    if (!catalog) return;
    if (reason === 'updating') {
      await ctx.reply(catalog.home.recovery.updating);
      return;
    }
    if (reason === 'unavailable') {
      await ctx.reply(catalog.home.recovery.unavailable);
      return;
    }
    await ctx.reply(catalog.home.recovery.stale, {
      reply_markup: new InlineKeyboard().text(catalog.home.recovery.openNewHome, OPEN_NEW_HOME_CALLBACK),
    });
  }

  private async deleteCallbackMessageWithoutFailing(ctx: TelegramContext): Promise<void> {
    const chatId = ctx.chat?.type === 'private' ? ctx.chat.id : undefined;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (chatId === undefined || messageId === undefined) return;
    await ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
  }

  private current(ctx: TelegramContext): { userId: number; chatId: number; state: LocaleState } | null {
    const userId = ctx.from?.id;
    const chat = ctx.chat;
    const state = ctx.localeState;
    if (!userId || chat?.type !== 'private' || state?.user.telegramId !== userId) return null;
    return { userId, chatId: chat.id, state };
  }
}
