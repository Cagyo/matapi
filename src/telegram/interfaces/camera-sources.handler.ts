import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { ConfigureLiveSourceUseCase } from '../../camera/application/configure-live-source.use-case';
import { ListLiveSourcesUseCase } from '../../camera/application/list-live-sources.use-case';
import { RemoveLiveSourceUseCase } from '../../camera/application/remove-live-source.use-case';
import type { RedactedLiveSource } from '../../camera/domain/ports/live-source-repository.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { en } from '../../locales/en';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import type { TelegramContext } from './telegram-context';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

const SOURCE_STATE_TTL_MS = 10 * 60_000;
const SELECTOR_LENGTH = 12;
const MAX_CALLBACK_BYTES = 64;

type SourceState =
  | { kind: 'camera'; receipt: WorkflowReturnReceipt; createdAtMs: number }
  | {
      kind: 'credential';
      receipt: WorkflowReturnReceipt;
      action: 'add' | 'edit' | 'test';
      cameraName: string;
      createdAtMs: number;
    }
  | {
      kind: 'selection';
      receipt: WorkflowReturnReceipt;
      action: 'edit' | 'test' | 'remove';
      choices: ReadonlyMap<string, RedactedLiveSource>;
      createdAtMs: number;
    };

/** Credential-safe source setup. CameraHandler validates `cam:<receipt>:src:*` before delegating here. */
@Injectable()
export class CameraSourcesHandler {
  private readonly states = new Map<string, SourceState>();

  constructor(
    private readonly configure: ConfigureLiveSourceUseCase,
    private readonly list: ListLiveSourcesUseCase,
    private readonly remove: RemoveLiveSourceUseCase,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  cancelPending(userId: number, chatId: number, receiptId?: string): void {
    if (receiptId) {
      this.states.delete(`${userId}:${chatId}:${receiptId}`);
      return;
    }
    for (const key of this.states.keys()) if (key.startsWith(`${userId}:${chatId}:`)) this.states.delete(key);
  }

  hasPending(userId: number, chatId: number, receiptId?: string): boolean {
    const state = receiptId ? this.states.get(`${userId}:${chatId}:${receiptId}`) : this.stateFor(userId, chatId);
    if (!state) return false;
    if (this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(this.keyFor(state));
      return false;
    }
    return true;
  }

  async handleEntry(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? (await this.workflows.begin(ctx, 'camera', { source: 'natural-parent' }));
    if (!receipt || !(await this.requireAdmin(ctx, receipt))) return;
    this.clear(ctx, receipt.id);
    const copy = this.copy(ctx);
    const keyboard = new InlineKeyboard()
      .text(copy.buttons.add, data(receipt.id, 'a'))
      .text(copy.buttons.edit, data(receipt.id, 'e'))
      .row()
      .text(copy.buttons.test, data(receipt.id, 't'))
      .text(copy.buttons.list, data(receipt.id, 'l'))
      .row()
      .text(copy.buttons.remove, data(receipt.id, 'r'))
      .text(copy.buttons.cancel, data(receipt.id, 'c'));
    await ctx.reply(copy.menuTitle, {
      reply_markup: this.withHome(ctx, receipt, keyboard),
    });
  }

  async handleCallback(ctx: TelegramContext, action: string, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!(await this.workflows.validateCurrent(ctx, receipt))) return;
    if (!(await this.requireAdmin(ctx, receipt))) return;
    const copy = this.copy(ctx);
    if (action === 'c') {
      this.clear(ctx, receipt.id);
      await this.complete(ctx, receipt, () => ctx.reply(copy.cancelled));
      return;
    }
    if (action === 'a') {
      this.set(ctx, { kind: 'camera', receipt, createdAtMs: this.now() });
      await ctx.reply(copy.cameraPrompt, {
        reply_markup: this.withHome(ctx, receipt, cancelKeyboard(receipt.id, copy)),
      });
      return;
    }
    if (action === 'l') {
      try {
        const sources = await this.list.execute();
        await this.complete(ctx, receipt, () => this.replyList(ctx, sources));
      } catch {
        await this.complete(ctx, receipt, () => ctx.reply(copy.listFailed));
      }
      return;
    }
    if (action === 'e' || action === 't' || action === 'r') {
      await this.beginSelection(ctx, receipt, action === 'e' ? 'edit' : action === 't' ? 'test' : 'remove');
      return;
    }
    const selected = /^s:([A-Za-z0-9_-]{12})$/.exec(action);
    if (!selected) return;
    const state = this.getCurrent(ctx, receipt.id);
    if (state?.kind !== 'selection') return;
    const source = state.choices.get(selected[1]);
    if (!source) return;
    if (state.action === 'remove') {
      if (!(await this.workflows.markRunning(ctx, receipt))) return;
      this.clear(ctx, receipt.id);
      try {
        await this.remove.execute(source.cameraId);
        await this.complete(ctx, receipt, () => ctx.reply(copy.removed(source.cameraName)));
      } catch {
        await this.complete(ctx, receipt, () => ctx.reply(copy.removeFailed));
      }
      return;
    }
    this.set(ctx, {
      kind: 'credential',
      receipt,
      action: state.action,
      cameraName: source.cameraName,
      createdAtMs: this.now(),
    });
    await ctx.reply(copy.credentialPrompt, {
      reply_markup: this.withHome(ctx, receipt, cancelKeyboard(receipt.id, copy)),
    });
  }

  /** Claims only a current source prompt; stale source state is never consumed. */
  async handleText(ctx: TelegramContext): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || chatId === undefined) return false;
    const state = this.stateFor(userId, chatId);
    if (!state || !(await this.workflows.validateCurrent(ctx, state.receipt))) return false;
    if (!(await this.requireAdmin(ctx, state.receipt))) return true;
    const copy = this.copy(ctx);
    if (this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(this.keyFor(state));
      await this.complete(ctx, state.receipt, () => ctx.reply(copy.expired));
      return true;
    }
    const text = ctx.message?.text?.trim();
    if (!text) return true;
    if (text.toLowerCase() === 'cancel') {
      this.clear(ctx, state.receipt.id);
      await this.complete(ctx, state.receipt, () => ctx.reply(copy.cancelled));
      return true;
    }
    if (state.kind === 'camera') {
      if (text.length > 64 || hasControlCharacter(text)) {
        await ctx.reply(copy.invalidCamera, {
          reply_markup: this.withHome(ctx, state.receipt, cancelKeyboard(state.receipt.id, copy)),
        });
        return true;
      }
      this.set(ctx, {
        kind: 'credential',
        receipt: state.receipt,
        action: 'add',
        cameraName: text,
        createdAtMs: this.now(),
      });
      await ctx.reply(copy.credentialPrompt, {
        reply_markup: this.withHome(ctx, state.receipt, cancelKeyboard(state.receipt.id, copy)),
      });
      return true;
    }
    if (state.kind !== 'credential') return true;
    if (!(await this.workflows.markRunning(ctx, state.receipt))) return true;
    this.states.delete(this.keyFor(state));
    const messageId = ctx.message?.message_id;
    let deleted = false;
    let configured: RedactedLiveSource | undefined;
    try {
      configured = await this.configure.execute({
        cameraName: state.cameraName,
        url: text,
        transport: 'tcp',
        tlsMode: /^rtsps:\/\//iu.test(text) ? 'strict' : 'none',
        profile: 'eco',
      });
    } catch {
      /* map every credential failure to safe localized copy */
    } finally {
      if (messageId !== undefined) {
        try {
          await ctx.api.deleteMessage(chatId, messageId);
          deleted = true;
        } catch {
          /* safe warning below */
        }
      }
    }
    await this.complete(ctx, state.receipt, async () => {
      await ctx.reply(
        configured
          ? state.action === 'test'
            ? copy.tested(configured.cameraName)
            : copy.configured(configured.cameraName)
          : copy.configureFailed,
      );
      if (!deleted) await ctx.reply(copy.deletionFailed);
    });
    return true;
  }

  private async beginSelection(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    action: 'edit' | 'test' | 'remove',
  ): Promise<void> {
    const copy = this.copy(ctx);
    let sources: RedactedLiveSource[];
    try {
      sources = await this.list.execute();
    } catch {
      await this.complete(ctx, receipt, () => ctx.reply(copy.listFailed));
      return;
    }
    if (sources.length === 0) {
      await this.complete(ctx, receipt, () => ctx.reply(copy.empty));
      return;
    }
    const choices = new Map(sources.map((source) => [selectorFor(source.cameraId), source]));
    this.set(ctx, {
      kind: 'selection',
      receipt,
      action,
      choices,
      createdAtMs: this.now(),
    });
    const keyboard = new InlineKeyboard();
    for (const [selector, source] of choices) keyboard.text(source.cameraName, data(receipt.id, `s:${selector}`)).row();
    keyboard.text(copy.buttons.cancel, data(receipt.id, 'c'));
    await ctx.reply(copy.chooseSource(action), {
      reply_markup: this.withHome(ctx, receipt, keyboard),
    });
  }

  private async replyList(ctx: TelegramContext, sources: RedactedLiveSource[]): Promise<void> {
    const copy = this.copy(ctx);
    if (sources.length === 0) {
      await ctx.reply(copy.empty);
      return;
    }
    const lines = sources.map((source) =>
      copy.sourceLine({
        cameraId: source.cameraId,
        cameraName: source.cameraName,
        scheme: source.summary.scheme,
        host: source.summary.host,
        transport: source.summary.transport,
        tlsMode: source.summary.tlsMode,
        profile: source.summary.profile,
        ready: source.summary.ready,
      }),
    );
    await ctx.reply(`${copy.listHeader}\n\n${lines.join('\n\n')}`);
  }

  private async requireAdmin(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<boolean> {
    if (ctx.localeState?.user.role === 'admin') return true;
    this.clear(ctx, receipt.id);
    await this.complete(ctx, receipt, () => ctx.reply(this.catalog(ctx).common.adminRequired));
    return false;
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    if (this.navigation) {
      await this.navigation.complete(
        ctx,
        { receipt },
        {
          effectStage: 'pending',
          deliver: async () => {
            await deliver();
          },
          failureNotice: this.catalog(ctx).home.recovery.unavailable,
        },
      );
      return;
    }
    await deliver();
  }

  private now(): number {
    return this.clock.now().getTime();
  }
  private set(ctx: TelegramContext, state: SourceState): void {
    this.states.set(this.key(ctx, state.receipt.id), state);
  }
  private clear(ctx: TelegramContext, receiptId: string): void {
    this.states.delete(this.key(ctx, receiptId));
  }
  private getCurrent(ctx: TelegramContext, receiptId: string): SourceState | undefined {
    const state = this.states.get(this.key(ctx, receiptId));
    if (state && this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(this.keyFor(state));
      return undefined;
    }
    return state;
  }
  private stateFor(userId: number, chatId: number): SourceState | undefined {
    for (const [key, state] of this.states) if (key.startsWith(`${userId}:${chatId}:`)) return state;
    return undefined;
  }
  private key(ctx: TelegramContext, receiptId: string): string {
    return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
  }
  private keyFor(state: SourceState): string {
    return `${state.receipt.userId}:${state.receipt.chatId}:${state.receipt.id}`;
  }
  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }
  private copy(ctx: TelegramContext): typeof en.camera.sources {
    return this.catalog(ctx).camera.sources ?? en.camera.sources;
  }
  private withHome(ctx: TelegramContext, receipt: WorkflowReturnReceipt, keyboard: InlineKeyboard): InlineKeyboard {
    return keyboard.row().text(this.catalog(ctx).home.common.home, workflowReturnCallback(receipt.id, 'origin'));
  }
}

function data(receiptId: string, action: string): string {
  const callback = `cam:${receiptId}:src:${action}`;
  if (Buffer.byteLength(callback, 'utf8') > MAX_CALLBACK_BYTES)
    throw new RangeError('Camera source callback data exceeds Telegram limit');
  return callback;
}
function selectorFor(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, SELECTOR_LENGTH);
}
function cancelKeyboard(receiptId: string, copy: typeof en.camera.sources): InlineKeyboard {
  return new InlineKeyboard().text(copy.buttons.cancel, data(receiptId, 'c'));
}
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127);
}
