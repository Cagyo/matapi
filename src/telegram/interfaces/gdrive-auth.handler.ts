import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { networkInterfaces, NetworkInterfaceInfo } from 'node:os';
import { UpdateGdriveAuthUseCase } from '../../camera/application/update-gdrive-auth.use-case';
import { GdriveAuthFailedError } from '../../camera/domain/errors/gdrive-auth-failed.error';
import { GdriveNotInstalledError } from '../../camera/domain/errors/gdrive-not-installed.error';
import { en, gb } from '../../locales/en';
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

const FALLBACK_SSH_HOST = '<pi-host>';
const SSH_HOST_ENV = 'HOME_WORKER_SSH_HOST';
const GDRIVE_AUTH_CALLBACK = /^gdauth:([A-Za-z0-9_-]{16}):(c)$/;

function interfacePriority(name: string): number {
  const lower = name.toLowerCase();
  if (/^(wlan|wl)/.test(lower)) return 0;
  if (/^(eth|en)/.test(lower)) return 1;
  if (/^(usb|wwan)/.test(lower)) return 2;
  if (/^(docker|br-|veth|lo|tun|tap|tailscale|zt)/.test(lower)) return 9;
  return 5;
}

function isUsableIpv4(address: NetworkInterfaceInfo): boolean {
  return (
    address.family === 'IPv4' &&
    !address.internal &&
    !address.address.startsWith('169.254.')
  );
}

export function resolveLocalSshHost(): string {
  const configured = process.env[SSH_HOST_ENV]?.trim();
  if (configured) return configured;

  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces).sort(
    (a, b) => interfacePriority(a) - interfacePriority(b),
  );

  for (const name of names) {
    const address = interfaces[name]?.find(isUsableIpv4);
    if (address) return address.address;
  }

  return FALLBACK_SSH_HOST;
}

@Injectable()
export class GdriveAuthHandler implements TelegramHandler, WorkflowDraftCanceller {
  private readonly logger = new Logger(GdriveAuthHandler.name);
  private readonly states = new Map<string, {
    userId: number;
    chatId: number;
    receiptId: string;
    receipt: WorkflowReturnReceipt;
  }>();
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';

  constructor(
    private readonly updateGdriveAuth: UpdateGdriveAuthUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly drafts: WorkflowDraftRegistry,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {
    this.drafts.register('drive-setup', this);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('gdrive_auth', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );

    composer.command('cancel', this.guard.adminOnly, async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (!state) return next();
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).gdriveAuth.cancelled));
    });

    composer.callbackQuery(/^gdauth:/, this.guard.adminOnly, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const parsed = parseGdriveAuthCallback(ctx.callbackQuery?.data ?? '');
      const state = this.stateFor(ctx);
      if (!parsed || !state) return;
      if (parsed.receiptId !== state.receiptId) return;
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).gdriveAuth.cancelled));
    });

    composer.on('message:text', async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (!state) return next();
      if (!(await this.requireCurrentAdmin(ctx, state))) return;

      const text = ctx.message?.text?.trim() ?? '';
      if (text.startsWith('/')) return next();

      if (!/\[gdrive\]/i.test(text)) {
        await ctx.reply(en.gdriveAuth.invalidSnippet, {
          parse_mode: 'Markdown',
          reply_markup: this.keyboard(ctx, state),
        });
        return;
      }

      await this.processSnippet(ctx, state, text);
    });

    composer.on('message:document', async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (!state) return next();
      if (!(await this.requireCurrentAdmin(ctx, state))) return;

      const doc = ctx.message?.document;
      if (!doc) return;

      const name = doc.file_name ?? '';
      if (!/\.(conf|txt)$/i.test(name)) {
        await ctx.reply(en.gdriveAuth.invalidSnippet, {
          parse_mode: 'Markdown',
          reply_markup: this.keyboard(ctx, state),
        });
        return;
      }

      let text: string;
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`download failed: ${response.status}`);
        }
        text = await response.text();
      } catch (error) {
        const token = this.botToken;
        const redactor = (str: string) =>
          token ? str.replace(new RegExp(token, 'g'), '[REDACTED_TOKEN]') : str;
        const msg = redactor((error as Error).message);
        const stack = redactor((error as Error).stack ?? '');
        this.logger.error(`gdrive_auth download failed: ${msg}`, stack);
        await ctx.reply(this.catalog(ctx).common.error('/gdrive_auth', 'could not download file'), {
          reply_markup: this.keyboard(ctx, state),
        });
        return;
      }

      if (!/\[gdrive\]/i.test(text)) {
        await ctx.reply(en.gdriveAuth.invalidSnippet, {
          parse_mode: 'Markdown',
          reply_markup: this.keyboard(ctx, state),
        });
        return;
      }

      await this.processSnippet(ctx, state, text);
    });
  }

  async cancelExact(input: {
    userId: number;
    chatId: number;
    receiptId: string;
  }): Promise<'cancelled' | 'missing' | 'superseded'> {
    const key = stateKey(input.userId, input.chatId);
    const state = this.states.get(key);
    if (!state) return 'missing';
    if (state.receiptId !== input.receiptId) return 'superseded';
    this.states.delete(key);
    return 'cancelled';
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'drive-setup', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    await this.startWizard(ctx, receipt);
  }

  private async startWizard(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const current = this.stateFor(ctx);
    if (current?.receiptId === receipt.id) {
      await ctx.reply(this.catalog(ctx).gdriveAuth.alreadyInProgress, {
        reply_markup: this.keyboard(ctx, current),
      });
      return;
    }
    const state = this.setState(receipt);
    await ctx.reply(this.catalog(ctx).gdriveAuth.prompt(resolveLocalSshHost()), {
      parse_mode: 'Markdown',
      reply_markup: this.keyboard(ctx, state),
    });
  }

  private async processSnippet(
    ctx: TelegramContext,
    state: { userId: number; chatId: number; receiptId: string; receipt: WorkflowReturnReceipt },
    snippet: string,
  ): Promise<void> {
    if (!(await this.requireCurrentAdmin(ctx, state))) return;

    // Role lookup and the filesystem writer remain separate async boundaries; making
    // role revocation and the write atomic requires a cross-context authorization redesign.
    try {
      if (!await this.workflows.markRunning(ctx, state.receipt)) return;
      const quota = await this.updateGdriveAuth.execute(snippet);
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).gdriveAuth.success(gb(quota.usedBytes), gb(quota.totalBytes))));
    } catch (err) {
      if (err instanceof GdriveNotInstalledError) {
        await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).gdriveAuth.notInstalled));
        return;
      }
      if (err instanceof GdriveAuthFailedError) {
        await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).gdriveAuth.failed(err.reason)));
        return;
      }
      this.logger.error(
        `/gdrive_auth failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await ctx.reply(this.catalog(ctx).common.error('/gdrive_auth', (err as Error).message), {
        reply_markup: this.keyboard(ctx, state),
      });
    }
  }

  private async requireCurrentAdmin(
    ctx: TelegramContext,
    state: { userId: number; chatId: number; receiptId: string; receipt: WorkflowReturnReceipt },
  ): Promise<boolean> {
    if (ctx.localeState?.user.role === 'admin') return true;
    await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).common.adminRequired));
    return false;
  }

  private setState(receipt: WorkflowReturnReceipt) {
    const state = {
      userId: receipt.userId,
      chatId: receipt.chatId,
      receiptId: receipt.id,
      receipt,
    };
    this.states.set(stateKey(state.userId, state.chatId), state);
    return state;
  }

  private stateFor(ctx: TelegramContext) {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || ctx.chat?.type !== 'private') return null;
    return this.states.get(stateKey(userId, ctx.chat.id)) ?? null;
  }

  private catalog(ctx: TelegramContext) {
    return ctx.localeState?.catalog ?? en;
  }

  private keyboard(
    ctx: TelegramContext,
    state: { receiptId: string },
  ): InlineKeyboard {
    const catalog = this.catalog(ctx);
    return new InlineKeyboard()
      .text(catalog.gdriveAuth.cancelled, `gdauth:${state.receiptId}:c`)
      .text(catalog.home.common.home, workflowReturnCallback(state.receiptId, 'home'));
  }

  private async complete(
    ctx: TelegramContext,
    state: { userId: number; chatId: number; receiptId: string; receipt: WorkflowReturnReceipt },
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

function parseGdriveAuthCallback(data: string): { receiptId: string; action: 'c' } | null {
  const match = GDRIVE_AUTH_CALLBACK.exec(data);
  return match ? { receiptId: match[1], action: 'c' } : null;
}
