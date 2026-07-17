import { Injectable, Logger, Optional } from '@nestjs/common';
import { CallbackQueryContext, Composer, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import { SystemDepsCheckFailedError } from '../../system/domain/errors/system-deps-check-failed.error';
import { SystemDepsCheck } from '../../system/domain/ports/system-deps.port';
import { SystemUpdateUseCase } from '../application/system-update.use-case';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import {
  WorkflowDraftRegistry,
  type WorkflowDraftCanceller,
} from './workflow-draft.registry';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

type UpdateStep =
  | { kind: 'checking' }
  | { kind: 'awaitingConfirm'; check: SystemDepsCheck };

type UpdateState = {
  userId: number;
  chatId: number;
  receiptId: string;
  receipt: WorkflowReturnReceipt;
} & UpdateStep;

const SYSTEM_UPDATE_CALLBACK = /^sysupd:([A-Za-z0-9_-]{16}):(a|c)$/;

/**
 * `/system_update` — spec 18. Admin-only, two-step flow mirroring
 * `/import_config`:
 *  1. Compute the installed-vs-available diff and show it.
 *  2. Apply/Cancel via inline keyboard; Apply spawns the detached
 *     `system-update.sh` script (snapshot → apt → rclone → node →
 *     health check → curl-on-failure).
 *
 * Per-user confirmation state is in-memory only (lost on restart) and only
 * ever holds entries for admins, since the command is admin-gated.
 */
@Injectable()
export class SystemUpdateHandler implements TelegramHandler, WorkflowDraftCanceller {
  private readonly logger = new Logger(SystemUpdateHandler.name);
  private readonly pending = new Map<string, UpdateState>();

  constructor(
    private readonly systemUpdate: SystemUpdateUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly drafts: WorkflowDraftRegistry,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {
    this.drafts.register('system-update', this);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('system_update', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
    composer.command('cancel', this.guard.adminOnly, async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (!state) return next();
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).systemUpdate.cancelled));
    });
    composer.callbackQuery(/^sysupd:/, this.guard.adminOnly, (ctx) =>
      this.onCallback(ctx),
    );
  }

  async cancelExact(input: {
    userId: number;
    chatId: number;
    receiptId: string;
  }): Promise<'cancelled' | 'missing' | 'superseded'> {
    const key = stateKey(input.userId, input.chatId);
    const state = this.pending.get(key);
    if (!state) return 'missing';
    if (state.receiptId !== input.receiptId) return 'superseded';
    this.pending.delete(key);
    return 'cancelled';
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'system-update', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const checking = this.setState(receipt, { kind: 'checking' });

    await ctx.reply(this.catalog(ctx).systemUpdate.checking, {
      reply_markup: this.keyboard(ctx, checking),
    });

    let check: SystemDepsCheck;
    try {
      check = await this.systemUpdate.check();
    } catch (err) {
      if (err instanceof SystemDepsCheckFailedError) {
        await this.complete(ctx, checking, () => ctx.reply(this.catalog(ctx).systemUpdate.checkFailed(err.reason)));
        return;
      }
      this.logger.error(
        `/system_update check failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.complete(ctx, checking, () => ctx.reply(this.catalog(ctx).systemUpdate.checkFailed((err as Error).message)));
      return;
    }

    if (!this.isCurrent(checking)) return;
    const catalog = this.catalog(ctx);
    const body = check.deps.map((d) => catalog.systemUpdate.depLine(d)).join('\n');
    const warning = check.nodeMajorMismatch ? this.nodeWarning(ctx, check) : null;

    if (!check.hasUpdates) {
      if (warning) {
        await this.complete(ctx, checking, () => ctx.reply(`${catalog.systemUpdate.header}\n\n${body}\n\n${warning}`));
        return;
      }
      await this.complete(ctx, checking, () => ctx.reply(catalog.systemUpdate.allUpToDate));
      return;
    }

    const pending = this.setState(receipt, { kind: 'awaitingConfirm', check });
    const lines = [catalog.systemUpdate.header, '', body];
    if (warning) lines.push('', warning);
    const keyboard = new InlineKeyboard()
      .text(catalog.systemUpdate.applyButton, systemUpdateCallback(pending.receiptId, 'a'))
      .text(catalog.systemUpdate.cancelButton, systemUpdateCallback(pending.receiptId, 'c'));
    await ctx.reply(lines.join('\n'), {
      reply_markup: this.keyboard(ctx, pending, keyboard),
    });
  }

  private async onCallback(ctx: CallbackQueryContext<TelegramContext>): Promise<void> {
    const parsed = parseSystemUpdateCallback(ctx.callbackQuery.data ?? '');
    await ctx.answerCallbackQuery().catch(() => undefined);
    const state = this.stateFor(ctx);
    if (!parsed || !state) return;
    if (parsed.receiptId !== state.receiptId) return;
    if (parsed.action === 'a' && state.kind !== 'awaitingConfirm') return;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

    if (parsed.action === 'c') {
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).systemUpdate.cancelled));
      return;
    }

    if (parsed.action === 'a' && state.kind === 'awaitingConfirm') {
      await this.cancelExact(state);
      if (!await this.workflows.markRunning(ctx, state.receipt)) return;
      try {
        await this.systemUpdate.apply();
        await ctx.reply(this.catalog(ctx).systemUpdate.applying, {
          reply_markup: this.runningKeyboard(ctx, state.receipt),
        });
      } catch (err) {
        this.logger.error(
          `/system_update apply failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).systemUpdate.checkFailed((err as Error).message)));
      }
    }
  }

  private nodeWarning(ctx: TelegramContext, check: SystemDepsCheck): string | null {
    const node = check.deps.find((d) => d.name === 'node');
    if (node?.kind !== 'node-major') return null;
    const desired = (node.available ?? '').replace(/\.x$/, '');
    return this.catalog(ctx).systemUpdate.nodeMajorWarning(node.current ?? '?', desired || '?');
  }

  private setState(
    receipt: WorkflowReturnReceipt,
    step: UpdateStep,
  ): UpdateState {
    const state: UpdateState = { ...step, userId: receipt.userId, chatId: receipt.chatId, receiptId: receipt.id, receipt };
    this.pending.set(stateKey(state.userId, state.chatId), state);
    return state;
  }

  private stateFor(ctx: TelegramContext): UpdateState | null {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || ctx.chat?.type !== 'private') return null;
    return this.pending.get(stateKey(userId, ctx.chat.id)) ?? null;
  }

  private isCurrent(state: UpdateState): boolean {
    return this.pending.get(stateKey(state.userId, state.chatId))?.receiptId === state.receiptId;
  }

  private catalog(ctx: TelegramContext) {
    return ctx.localeState?.catalog ?? en;
  }

  private keyboard(ctx: TelegramContext, state: UpdateState, keyboard = new InlineKeyboard()): InlineKeyboard {
    const catalog = this.catalog(ctx);
    return keyboard.row()
      .text(catalog.systemUpdate.cancelButton, systemUpdateCallback(state.receiptId, 'c'))
      .text(catalog.home.common.home, workflowReturnCallback(state.receiptId, 'home'));
  }

  private runningKeyboard(ctx: TelegramContext, receipt: WorkflowReturnReceipt): InlineKeyboard {
    const catalog = this.catalog(ctx);
    return new InlineKeyboard()
      .text(catalog.home.common.back, workflowReturnCallback(receipt.id, 'origin'))
      .text(catalog.home.common.home, workflowReturnCallback(receipt.id, 'home'));
  }

  private async complete(
    ctx: TelegramContext,
    state: UpdateState,
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt: state.receipt }, {
        effectStage: 'pending',
        deliver: async () => { await deliver(); },
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    await deliver();
    await this.cancelExact(state);
  }
}

function stateKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function systemUpdateCallback(receiptId: string, action: 'a' | 'c'): string {
  return `sysupd:${receiptId}:${action}`;
}

function parseSystemUpdateCallback(data: string): { receiptId: string; action: 'a' | 'c' } | null {
  const match = SYSTEM_UPDATE_CALLBACK.exec(data);
  return match ? { receiptId: match[1], action: match[2] as 'a' | 'c' } : null;
}
