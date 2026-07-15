import { Inject, Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import { ConfigureLiveSourceUseCase } from '../../camera/application/configure-live-source.use-case';
import { ListLiveSourcesUseCase } from '../../camera/application/list-live-sources.use-case';
import { RemoveLiveSourceUseCase } from '../../camera/application/remove-live-source.use-case';
import type { RedactedLiveSource } from '../../camera/domain/ports/live-source-repository.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { en } from '../../locales/en';
import type { TelegramContext } from './telegram-context';

const SOURCE_STATE_TTL_MS = 10 * 60_000;

type SourceAction = 'add' | 'edit' | 'test' | 'remove';
type SourceState =
  | { kind: 'camera'; action: 'add'; createdAtMs: number }
  | { kind: 'credential'; action: 'add' | 'edit' | 'test'; cameraName: string; createdAtMs: number }
  | { kind: 'selection'; action: 'edit' | 'test' | 'remove'; createdAtMs: number }
  | { kind: 'list'; createdAtMs: number };

/** Delegated admin flow for credential-safe RTSP source management. */
@Injectable()
export class CameraSourcesHandler {
  private readonly states = new Map<string, SourceState>();

  constructor(
    private readonly configure: ConfigureLiveSourceUseCase,
    private readonly list: ListLiveSourcesUseCase,
    private readonly remove: RemoveLiveSourceUseCase,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  private now(): number {
    return this.clock.now().getTime();
  }

  cancelPending(userId: number, chatId: number): void {
    this.states.delete(`${userId}:${chatId}`);
  }

  hasPending(userId: number, chatId: number): boolean {
    const key = `${userId}:${chatId}`;
    const state = this.states.get(key);
    if (state && this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(key);
      return false;
    }
    return state !== undefined;
  }

  async handleEntry(ctx: TelegramContext): Promise<void> {
    if (!(await this.requireAdmin(ctx))) return;
    this.clear(ctx);
    const copy = this.copy(ctx);
    const keyboard = new InlineKeyboard()
      .text(copy.buttons.add, 'cam:sources:add')
      .text(copy.buttons.edit, 'cam:sources:edit')
      .row()
      .text(copy.buttons.test, 'cam:sources:test')
      .text(copy.buttons.list, 'cam:sources:list')
      .row()
      .text(copy.buttons.remove, 'cam:sources:remove')
      .text(copy.buttons.cancel, 'cam:sources:cancel');
    await ctx.reply(copy.menuTitle, { reply_markup: keyboard });
  }

  async handleCallback(ctx: TelegramContext, data: string): Promise<void> {
    if (!(await this.requireAdmin(ctx))) return;
    try {
      await this.handleAdminCallback(ctx, data);
    } catch (error) {
      this.clear(ctx);
      throw error;
    }
  }

  private async handleAdminCallback(ctx: TelegramContext, data: string): Promise<void> {
    const copy = this.copy(ctx);
    if (data === 'cancel') {
      this.clear(ctx);
      await ctx.reply(copy.cancelled);
      return;
    }
    if (data === 'add') {
      this.set(ctx, { kind: 'camera', action: 'add', createdAtMs: this.now() });
      await ctx.reply(copy.cameraPrompt, { reply_markup: cancelKeyboard(copy) });
      return;
    }
    if (data === 'list') {
      this.set(ctx, { kind: 'list', createdAtMs: this.now() });
      try {
        await this.replyList(ctx, await this.list.execute());
      } catch {
        await ctx.reply(copy.listFailed);
      } finally {
        this.clear(ctx);
      }
      return;
    }
    if (data === 'edit' || data === 'test' || data === 'remove') {
      await this.beginSelection(ctx, data);
      return;
    }

    const separator = data.indexOf(':');
    if (separator < 1) {
      this.clear(ctx);
      await ctx.reply(copy.staleSelection);
      return;
    }
    const action = data.slice(0, separator);
    const cameraId = decodeSelection(data.slice(separator + 1));
    if (!isSelectionAction(action) || !cameraId) {
      this.clear(ctx);
      await ctx.reply(copy.staleSelection);
      return;
    }
    const state = this.getCurrent(ctx);
    if (state?.kind !== 'selection' || state.action !== action) {
      this.clear(ctx);
      await ctx.reply(copy.staleSelection);
      return;
    }

    let selected: RedactedLiveSource | undefined;
    try {
      selected = (await this.list.execute()).find((item) => item.cameraId === cameraId);
    } catch {
      this.clear(ctx);
      await ctx.reply(copy.listFailed);
      return;
    }
    if (!selected) {
      this.clear(ctx);
      await ctx.reply(copy.staleSelection);
      return;
    }
    if (action === 'remove') {
      this.clear(ctx);
      try {
        await this.remove.execute(selected.cameraId);
        await ctx.reply(copy.removed(selected.cameraName));
      } catch {
        await ctx.reply(copy.removeFailed);
      }
      return;
    }
    this.set(ctx, {
      kind: 'credential',
      action,
      cameraName: selected.cameraName,
      createdAtMs: this.now(),
    });
    await ctx.reply(copy.credentialPrompt, { reply_markup: cancelKeyboard(copy) });
  }

  /** Returns true only when a source-management state claimed this message. */
  async handleText(ctx: TelegramContext): Promise<boolean> {
    const key = this.key(ctx);
    if (!key) return false;
    const state = this.states.get(key);
    if (!state) return false;
    if (!(await this.requireAdmin(ctx))) return true;
    try {
      return await this.handleStateText(ctx, key, state);
    } catch (error) {
      this.states.delete(key);
      throw error;
    }
  }

  private async handleStateText(
    ctx: TelegramContext,
    key: string,
    state: SourceState,
  ): Promise<boolean> {
    const copy = this.copy(ctx);
    if (this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(key);
      await ctx.reply(copy.expired);
      return true;
    }

    const text = ctx.message?.text?.trim();
    if (!text) return true;
    if (text.toLowerCase() === 'cancel') {
      this.states.delete(key);
      await ctx.reply(copy.cancelled);
      return true;
    }
    if (state.kind === 'camera') {
      if (text.length > 64 || hasControlCharacter(text)) {
        await ctx.reply(copy.invalidCamera);
        return true;
      }
      this.states.set(key, {
        kind: 'credential',
        action: 'add',
        cameraName: text,
        createdAtMs: this.now(),
      });
      await ctx.reply(copy.credentialPrompt, { reply_markup: cancelKeyboard(copy) });
      return true;
    }
    if (state.kind !== 'credential') return true;

    this.states.delete(key);
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    let deletionFailed = false;
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
      // The interface boundary maps every source/configuration failure to safe copy below.
    } finally {
      if (chatId !== undefined && messageId !== undefined) {
        try {
          await ctx.api.deleteMessage(chatId, messageId);
        } catch {
          deletionFailed = true;
        }
      }
    }
    if (configured) {
      await ctx.reply(
        state.action === 'test'
          ? copy.tested(configured.cameraName)
          : copy.configured(configured.cameraName),
      );
    } else {
      await ctx.reply(copy.configureFailed);
    }
    if (deletionFailed) await ctx.reply(copy.deletionFailed);
    return true;
  }

  private async beginSelection(
    ctx: TelegramContext,
    action: Exclude<SourceAction, 'add'>,
  ): Promise<void> {
    const copy = this.copy(ctx);
    let sources: RedactedLiveSource[];
    try {
      sources = await this.list.execute();
    } catch {
      this.clear(ctx);
      await ctx.reply(copy.listFailed);
      return;
    }
    if (sources.length === 0) {
      this.clear(ctx);
      await ctx.reply(copy.empty);
      return;
    }
    this.set(ctx, { kind: 'selection', action, createdAtMs: this.now() });
    const keyboard = new InlineKeyboard();
    for (const item of sources) {
      keyboard.text(item.cameraName, `cam:sources:${action}:${encodeURIComponent(item.cameraId)}`).row();
    }
    keyboard.text(copy.buttons.cancel, 'cam:sources:cancel');
    await ctx.reply(copy.chooseSource(action), { reply_markup: keyboard });
  }

  private async replyList(ctx: TelegramContext, sources: RedactedLiveSource[]): Promise<void> {
    const copy = this.copy(ctx);
    if (sources.length === 0) {
      await ctx.reply(copy.empty);
      return;
    }
    const lines = sources.map(({ cameraId, cameraName, summary }) => copy.sourceLine({
      cameraId,
      cameraName,
      scheme: summary.scheme,
      host: summary.host,
      transport: summary.transport,
      tlsMode: summary.tlsMode,
      profile: summary.profile,
      ready: summary.ready,
    }));
    await ctx.reply(`${copy.listHeader}\n\n${lines.join('\n\n')}`);
  }

  private async requireAdmin(ctx: TelegramContext): Promise<boolean> {
    if (ctx.localeState?.user.role === 'admin') return true;
    this.clear(ctx);
    await ctx.reply(this.catalog(ctx).common.adminRequired);
    return false;
  }

  private getCurrent(ctx: TelegramContext): SourceState | undefined {
    const key = this.key(ctx);
    if (!key) return undefined;
    const state = this.states.get(key);
    if (state && this.now() - state.createdAtMs > SOURCE_STATE_TTL_MS) {
      this.states.delete(key);
      return undefined;
    }
    return state;
  }

  private set(ctx: TelegramContext, state: SourceState): void {
    const key = this.key(ctx);
    if (key) this.states.set(key, state);
  }

  private clear(ctx: TelegramContext): void {
    const key = this.key(ctx);
    if (key) this.states.delete(key);
  }

  private key(ctx: TelegramContext): string | null {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    return userId === undefined || chatId === undefined ? null : `${userId}:${chatId}`;
  }

  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

  private copy(ctx: TelegramContext): typeof en.camera.sources {
    return this.catalog(ctx).camera.sources ?? en.camera.sources;
  }
}

function isSelectionAction(value: string): value is 'edit' | 'test' | 'remove' {
  return value === 'edit' || value === 'test' || value === 'remove';
}

function decodeSelection(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function cancelKeyboard(copy: typeof en.camera.sources): InlineKeyboard {
  return new InlineKeyboard().text(copy.buttons.cancel, 'cam:sources:cancel');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
