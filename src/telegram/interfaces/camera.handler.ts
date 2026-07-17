import { Injectable, Logger, Optional } from '@nestjs/common';
import { parse } from 'date-fns';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { BrowseMotionEventsUseCase } from '../../camera/application/browse-motion-events.use-case';
import { CameraStatusUseCase } from '../../camera/application/camera-status.use-case';
import { DisableMotionUseCase } from '../../camera/application/disable-motion.use-case';
import { EnableMotionUseCase } from '../../camera/application/enable-motion.use-case';
import { GetMotionPhotoUseCase } from '../../camera/application/get-motion-photo.use-case';
import { GetMotionVideoUseCase, type VideoDelivery } from '../../camera/application/get-motion-video.use-case';
import { GetSnapshotUseCase } from '../../camera/application/get-snapshot.use-case';
import { ListMotionEventsUseCase } from '../../camera/application/list-motion-events.use-case';
import { OpenLiveStreamUseCase } from '../../camera/application/open-live-stream.use-case';
import { LiveStreamSessionService } from '../../camera/application/live-stream-session.service';
import { StopLiveStreamUseCase } from '../../camera/application/stop-live-stream.use-case';
import { EventNotFoundError } from '../../camera/domain/errors/event-not-found.error';
import { LiveStreamExpiredError } from '../../camera/domain/errors/live-stream-expired.error';
import { LiveStreamSourceUnavailableError } from '../../camera/domain/errors/live-stream-source-unavailable.error';
import { LiveStreamUnavailableError } from '../../camera/domain/errors/live-stream-unavailable.error';
import { type BrowseMotionEvent } from '../../camera/domain/ports/media-repository.port';
import { eventDurationSec, type MotionEvent } from '../../camera/domain/motion-event.entity';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { en } from '../../locales/en';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import { CameraSourcesHandler } from './camera-sources.handler';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext } from './telegram-context';
import { TelegramHandler } from './telegram-handler';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

const CAMERA_BROWSE_TTL_MS = 10 * 60_000;
const MAX_CALLBACK_BYTES = 64;
const CAMERA_CALLBACK = /^cam:([A-Za-z0-9_-]{16}):(.+)$/;

type Subcommand =
  | 'snapshot'
  | 'events'
  | 'video'
  | 'photo'
  | 'enable'
  | 'disable'
  | 'status'
  | 'live'
  | 'stop_stream'
  | 'menu'
  | 'dashboard'
  | 'sources';
type BrowseInput =
  | { kind: 'date'; receipt: WorkflowReturnReceipt; createdAtMs: number }
  | {
      kind: 'range';
      receipt: WorkflowReturnReceipt;
      date: Date;
      label: string;
      createdAtMs: number;
    };
interface BrowseResults {
  receipt: WorkflowReturnReceipt;
  events: BrowseMotionEvent[];
  header: string;
  createdAtMs: number;
}

@Injectable()
export class CameraHandler implements TelegramHandler {
  private readonly logger = new Logger(CameraHandler.name);
  private readonly launches = new Map<string, WorkflowReturnReceipt>();
  private readonly receiptCatalogs = new Map<string, LocaleCatalog>();
  private readonly inputs = new Map<string, BrowseInput>();
  private readonly results = new Map<string, BrowseResults>();

  constructor(
    private readonly snapshot: GetSnapshotUseCase,
    private readonly listEvents: ListMotionEventsUseCase,
    private readonly browseEvents: BrowseMotionEventsUseCase,
    private readonly video: GetMotionVideoUseCase,
    private readonly photo: GetMotionPhotoUseCase,
    private readonly enable: EnableMotionUseCase,
    private readonly disable: DisableMotionUseCase,
    private readonly status: CameraStatusUseCase,
    private readonly openLiveStream: OpenLiveStreamUseCase,
    private readonly stopLiveStream: StopLiveStreamUseCase,
    private readonly liveStreamSessions: LiveStreamSessionService,
    private readonly guard: RoleMiddleware,
    private readonly sources: CameraSourcesHandler,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  cancelPending(userId: number, chatId: number): void {
    for (const key of [...this.inputs.keys(), ...this.results.keys(), ...this.launches.keys()]) {
      if (key.startsWith(`${userId}:${chatId}:`)) {
        this.inputs.delete(key);
        this.results.delete(key);
        this.launches.delete(key);
      }
    }
    this.sources.cancelPending(userId, chatId);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('camera', this.guard.registered, async (ctx) => {
      if (!ctx.from || !ctx.message || ctx.chat?.type !== 'private') return;
      const receipt = await this.workflows.begin(ctx, 'camera', {
        source: 'natural-parent',
      });
      if (!receipt) return;
      this.remember(ctx, receipt);
      const [subToken = '', ...rest] = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
      const sub = subToken.toLowerCase() as Subcommand | '';
      try {
        await this.dispatch(ctx, receipt, sub, rest.join(' '));
      } catch (error) {
        await this.handleError(ctx, receipt, error, `/camera ${sub}`);
      }
    });

    composer.callbackQuery(CAMERA_CALLBACK, this.guard.registered, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (ctx.chat?.type !== 'private') return;
      const parsed = parseCameraCallback(ctx.callbackQuery?.data ?? '');
      if (!parsed) return;
      const receipt = this.launches.get(this.key(ctx, parsed.receiptId));
      if (!receipt || !(await this.workflows.validateCurrent(ctx, receipt))) return;
      try {
        await this.dispatchCallback(ctx, receipt, parsed.action);
      } catch (error) {
        await this.handleError(ctx, receipt, error, '/camera callback');
      }
    });

    composer.on('message:text', this.guard.registered, async (ctx, next) => {
      if (ctx.message?.text?.startsWith('/')) return next();
      try {
        if (await this.sources.handleText(ctx)) return;
        const input = this.inputFor(ctx);
        if (!input || !(await this.workflows.validateCurrent(ctx, input.receipt))) return next();
        await this.handleBrowseText(ctx, input, ctx.message.text.trim());
      } catch (error) {
        const input = this.inputFor(ctx);
        if (input) await this.handleError(ctx, input.receipt, error, '/camera browse text');
      }
    });
  }

  async handleDashboard(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? (await this.workflows.begin(ctx, 'camera', { source: 'natural-parent' }));
    if (!receipt) return;
    this.remember(ctx, receipt);
    const keyboard = new InlineKeyboard()
      .text(this.catalog(ctx).camera.dashboardButtons.live, callback(receipt.id, 'l'))
      .row()
      .text(en.camera.dashboardButtons.snapshot, callback(receipt.id, 's'))
      .text(en.camera.dashboardButtons.browseEvents, callback(receipt.id, 'b'))
      .row()
      .text(en.camera.dashboardButtons.eventsToday, callback(receipt.id, 'e'))
      .text(en.camera.dashboardButtons.status, callback(receipt.id, 'q'))
      .row()
      .text(en.camera.dashboardButtons.close, callback(receipt.id, 'x'));
    await ctx.reply(en.camera.dashboardTitle, {
      reply_markup: this.withHome(receipt, keyboard),
    });
  }

  private async dispatch(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    sub: Subcommand | '',
    arg: string,
  ): Promise<void> {
    switch (sub) {
      case '':
      case 'menu':
      case 'dashboard':
        return this.handleDashboard(ctx, { receipt });
      case 'snapshot':
        return this.handleSnapshot(ctx, receipt, arg || undefined);
      case 'events':
        return this.handleEvents(ctx, receipt, arg || undefined);
      case 'video':
        return this.handleVideo(ctx, receipt, arg);
      case 'photo':
        return this.handlePhoto(ctx, receipt, arg);
      case 'enable':
        return this.handleEnable(ctx, receipt);
      case 'disable':
        return this.handleDisable(ctx, receipt);
      case 'status':
        return this.handleStatus(ctx, receipt);
      case 'live':
        return this.handleLive(ctx, receipt, arg || undefined);
      case 'stop_stream':
        return this.handleStopLive(ctx, receipt);
      case 'sources':
        return this.sources.handleEntry(ctx, { receipt });
      default:
        return this.complete(ctx, receipt, () => ctx.reply(en.camera.usage));
    }
  }

  private async dispatchCallback(ctx: TelegramContext, receipt: WorkflowReturnReceipt, action: string): Promise<void> {
    if (action.startsWith('src:')) return this.sources.handleCallback(ctx, action.slice(4), receipt);
    if (action === 'd') return this.handleDashboard(ctx, { receipt });
    if (action === 's') return this.handleSnapshot(ctx, receipt);
    if (action === 'e') return this.handleEvents(ctx, receipt);
    if (action === 'q') return this.handleStatus(ctx, receipt);
    if (action === 'l') return this.handleLive(ctx, receipt);
    if (action.startsWith('l:')) return this.handleLive(ctx, receipt, action.slice(2), 'id');
    if (action === 'x') return this.complete(ctx, receipt, () => ctx.reply(en.camera.closed));
    if (action === 'b') return this.browseMenu(ctx, receipt);
    if (action === 'bt') return this.browseRelative(ctx, receipt, 'today');
    if (action === 'by') return this.browseRelative(ctx, receipt, 'yesterday');
    if (action === 'bp') return this.browsePickDate(ctx, receipt);
    if (action === 'bl') return this.browseLatest(ctx, receipt);
    if (action === 'bb') return this.browseBack(ctx, receipt);
    if (action === 'bc') return this.complete(ctx, receipt, () => ctx.reply(en.camera.browse.cancelled));
    if (action === 'br') return this.browseBackResults(ctx, receipt);
    if (action.startsWith('be:')) return this.browseEvent(ctx, receipt, action.slice(3));
    if (action.startsWith('bv:')) return this.browseVideo(ctx, receipt, action.slice(3));
    if (action.startsWith('bp:')) return this.browsePhoto(ctx, receipt, action.slice(3));
    if (action.startsWith('v:')) return this.handleVideo(ctx, receipt, action.slice(2));
    if (action.startsWith('p:')) return this.handlePhoto(ctx, receipt, action.slice(2));
  }

  private async browseMenu(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    this.clearBrowse(ctx, receipt.id);
    const keyboard = new InlineKeyboard()
      .text(en.camera.browse.buttons.today, callback(receipt.id, 'bt'))
      .text(en.camera.browse.buttons.yesterday, callback(receipt.id, 'by'))
      .row()
      .text(en.camera.browse.buttons.pickDate, callback(receipt.id, 'bp'))
      .text(en.camera.browse.buttons.latest, callback(receipt.id, 'bl'))
      .row()
      .text(en.camera.browse.buttons.back, callback(receipt.id, 'd'))
      .text(en.camera.browse.buttons.cancel, callback(receipt.id, 'bc'));
    await ctx.reply(en.camera.browse.menuTitle, {
      reply_markup: this.withHome(receipt, keyboard),
    });
  }

  private async browsePickDate(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    this.clearBrowse(ctx, receipt.id);
    this.inputs.set(this.key(ctx, receipt.id), {
      kind: 'date',
      receipt,
      createdAtMs: Date.now(),
    });
    await ctx.reply(en.camera.browse.datePrompt, {
      reply_markup: this.withHome(
        receipt,
        new InlineKeyboard().text(en.camera.browse.buttons.cancel, callback(receipt.id, 'bc')),
      ),
    });
  }

  private async browseRelative(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    mode: 'today' | 'yesterday',
  ): Promise<void> {
    const date = new Date();
    if (mode === 'yesterday') date.setDate(date.getDate() - 1);
    this.clearBrowse(ctx, receipt.id);
    this.inputs.set(this.key(ctx, receipt.id), {
      kind: 'range',
      receipt,
      date,
      label: formatBrowseDateLabel(date),
      createdAtMs: Date.now(),
    });
    await ctx.reply(en.camera.browse.timeRangePrompt(mode), {
      reply_markup: this.withHome(
        receipt,
        new InlineKeyboard().text(en.camera.browse.buttons.cancel, callback(receipt.id, 'bc')),
      ),
    });
  }

  private async handleBrowseText(ctx: TelegramContext, input: BrowseInput, text: string): Promise<void> {
    if (Date.now() - input.createdAtMs > CAMERA_BROWSE_TTL_MS) {
      this.clearBrowse(ctx, input.receipt.id);
      await this.complete(ctx, input.receipt, () => ctx.reply(en.camera.browse.expiredInput));
      return;
    }
    if (input.kind === 'date') {
      const parsed = parseBrowseDateInput(text);
      if (!parsed.ok) {
        await ctx.reply(en.camera.browse.invalidDate, {
          reply_markup: this.withHome(input.receipt),
        });
        return;
      }
      this.inputs.set(this.key(ctx, input.receipt.id), {
        kind: 'range',
        receipt: input.receipt,
        date: parsed.date,
        label: parsed.dateLabel,
        createdAtMs: Date.now(),
      });
      await ctx.reply(en.camera.browse.timeRangePrompt(parsed.dateLabel), {
        reply_markup: this.withHome(input.receipt),
      });
      return;
    }
    const range = parseTimeRangeInput(text);
    if (!range.ok) {
      await ctx.reply(
        range.reason === 'order' ? en.camera.browse.invalidTimeOrder : en.camera.browse.invalidTimeRange,
        { reply_markup: this.withHome(input.receipt) },
      );
      return;
    }
    const dates = buildBrowseRange(input.date, range);
    this.inputs.delete(this.key(ctx, input.receipt.id));
    const result = await this.browseEvents.between(dates.start, dates.end);
    await this.replyBrowseResults(
      ctx,
      input.receipt,
      result.events,
      en.camera.browse.rangeHeader(input.label, dates.rangeLabel, result.events.length, result.hasMore),
    );
  }

  private async browseLatest(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const result = await this.browseEvents.latest();
    await this.replyBrowseResults(ctx, receipt, result.events, en.camera.browse.latestHeader(result.events.length));
  }

  private async replyBrowseResults(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    events: BrowseMotionEvent[],
    header: string,
  ): Promise<void> {
    this.results.set(this.key(ctx, receipt.id), {
      receipt,
      events,
      header,
      createdAtMs: Date.now(),
    });
    if (events.length === 0) {
      await ctx.reply(en.camera.browse.emptyLatest, {
        reply_markup: this.withHome(receipt, this.browseNavigation(receipt)),
      });
      return;
    }
    const lines = events.map((event) => en.camera.browse.eventLine(this.browseLine(event)));
    await ctx.reply([header, '', ...lines].join('\n'), {
      reply_markup: this.withHome(receipt, this.browseResultsKeyboard(receipt, events)),
    });
  }

  private async browseEvent(ctx: TelegramContext, receipt: WorkflowReturnReceipt, rawId: string): Promise<void> {
    const id = parseEventId(rawId);
    const event = id === null ? undefined : this.currentEvent(ctx, receipt, id);
    if (!event) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.browse.resultsExpired));
      return;
    }
    const keyboard = new InlineKeyboard();
    if ((!!event.videoPath && !event.localDeleted) || !!event.gdriveFileId)
      keyboard.text(en.camera.browse.buttons.video, callback(receipt.id, `bv:${event.id}`));
    if (!!event.snapshotPath && !event.localDeleted)
      keyboard.text(en.camera.browse.buttons.photo, callback(receipt.id, `bp:${event.id}`));
    keyboard.row().text(en.camera.browse.buttons.backToResults, callback(receipt.id, 'br'));
    await ctx.reply(en.camera.browse.actionHeader(this.browseLine(event)), {
      reply_markup: this.withHome(receipt, keyboard),
    });
  }

  private async browseVideo(ctx: TelegramContext, receipt: WorkflowReturnReceipt, rawId: string): Promise<void> {
    const id = parseEventId(rawId);
    if (id === null || !this.currentEvent(ctx, receipt, id)) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.browse.resultsExpired));
      return;
    }
    await this.deliverVideo(ctx, receipt, id, this.browseNavigation(receipt));
  }
  private async browsePhoto(ctx: TelegramContext, receipt: WorkflowReturnReceipt, rawId: string): Promise<void> {
    const id = parseEventId(rawId);
    if (id === null || !this.currentEvent(ctx, receipt, id)) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.browse.resultsExpired));
      return;
    }
    if (!(await this.workflows.markRunning(ctx, receipt))) return;
    await ctx.replyWithChatAction('upload_photo');
    const photo = await this.photo.execute(id);
    await ctx.replyWithPhoto(new InputFile(photo.path), {
      caption: en.camera.photoCaption(photo.event.id, photo.event.startedAt, photo.event.cameraId ?? '—'),
      reply_markup: this.withHome(receipt, this.browseNavigation(receipt)),
    });
  }
  private async browseBackResults(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const result = this.currentResults(ctx, receipt);
    if (!result || result.events.length === 0) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.browse.resultsExpired));
      return;
    }
    await ctx.reply(
      [result.header, '', ...result.events.map((event) => en.camera.browse.eventLine(this.browseLine(event)))].join(
        '\n',
      ),
      {
        reply_markup: this.withHome(receipt, this.browseResultsKeyboard(receipt, result.events)),
      },
    );
  }
  private async browseBack(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    this.clearBrowse(ctx, receipt.id);
    await this.browseMenu(ctx, receipt);
  }

  private async handleSnapshot(ctx: TelegramContext, receipt: WorkflowReturnReceipt, name?: string): Promise<void> {
    if (!(await this.workflows.markRunning(ctx, receipt))) return;
    await ctx.replyWithChatAction('upload_photo');
    const result = await this.snapshot.execute(name);
    await this.complete(ctx, receipt, () =>
      ctx.replyWithPhoto(new InputFile(result.buffer, 'snapshot.jpg'), {
        caption: en.camera.snapshotCaption(result.cameraName, result.takenAt),
      }),
    );
  }
  private async handleEvents(ctx: TelegramContext, receipt: WorkflowReturnReceipt, dateArg?: string): Promise<void> {
    const day = dateArg ? parse(dateArg, 'dd.MM.yyyy', new Date()) : new Date();
    if (Number.isNaN(day.getTime())) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.invalidDate));
      return;
    }
    const events = await this.listEvents.execute(day);
    if (events.length === 0) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.eventsNone(day)));
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const event of events.slice(0, 5)) {
      keyboard.text(en.camera.eventButtons.video(event.id), callback(receipt.id, `v:${event.id}`));
      if (event.snapshotPath)
        keyboard.text(en.camera.eventButtons.photo(event.id), callback(receipt.id, `p:${event.id}`));
      keyboard.row();
    }
    await ctx.reply(
      [
        en.camera.eventsHeader(day),
        ...events.map((event) =>
          en.camera.eventLine({
            id: event.id,
            startedAt: event.startedAt,
            durationSec: eventDurationSec(event),
            hasSnapshot: !!event.snapshotPath,
          }),
        ),
        '',
        en.camera.eventsFooter(events.length),
      ].join('\n'),
      { reply_markup: this.withHome(receipt, keyboard) },
    );
  }
  private async handleVideo(ctx: TelegramContext, receipt: WorkflowReturnReceipt, rawId: string): Promise<void> {
    const id = parseEventId(rawId);
    if (id === null) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.usage));
      return;
    }
    await this.deliverVideo(ctx, receipt, id);
  }
  private async deliverVideo(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    id: number,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    if (!(await this.workflows.markRunning(ctx, receipt))) return;
    const delivery = await this.video.execute(id);
    if (delivery.kind === 'drive') {
      await this.complete(ctx, receipt, () =>
        ctx.reply(
          en.camera.driveLinkFallback(id, delivery.event.gdriveFileId),
          keyboard ? { reply_markup: this.withHome(receipt, keyboard) } : {},
        ),
      );
      return;
    }
    await ctx.replyWithChatAction('upload_video');
    await this.complete(ctx, receipt, () =>
      ctx.replyWithVideo(new InputFile(delivery.path), {
        caption: caption(delivery, id),
        ...(keyboard ? { reply_markup: this.withHome(receipt, keyboard) } : {}),
      }),
    );
  }
  private async handlePhoto(ctx: TelegramContext, receipt: WorkflowReturnReceipt, rawId: string): Promise<void> {
    const id = parseEventId(rawId);
    if (id === null) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.usage));
      return;
    }
    if (!(await this.workflows.markRunning(ctx, receipt))) return;
    await ctx.replyWithChatAction('upload_photo');
    const photo = await this.photo.execute(id);
    await this.complete(ctx, receipt, () =>
      ctx.replyWithPhoto(new InputFile(photo.path), {
        caption: en.camera.photoCaption(photo.event.id, photo.event.startedAt, photo.event.cameraId ?? '—'),
      }),
    );
  }
  private async handleEnable(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!(await this.requireAdmin(ctx, receipt)) || !(await this.workflows.markRunning(ctx, receipt))) return;
    await this.enable.execute();
    await this.complete(ctx, receipt, () => ctx.reply(en.camera.motionStarted));
  }
  private async handleDisable(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    if (!(await this.requireAdmin(ctx, receipt)) || !(await this.workflows.markRunning(ctx, receipt))) return;
    await this.disable.execute();
    await this.complete(ctx, receipt, () => ctx.reply(en.camera.motionStopped));
  }
  private async handleStatus(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const status = await this.status.execute();
    await this.complete(ctx, receipt, () => ctx.reply(`${en.camera.statusHeader}\n\n${en.camera.statusBody(status)}`));
  }

  private async handleLive(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    reference?: string,
    resolution: 'name' | 'id' = 'name',
  ): Promise<void> {
    const telegramId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!telegramId || chatId === undefined || !(await this.workflows.markRunning(ctx, receipt))) return;
    const live = this.catalog(ctx).camera.live;
    await ctx.reply(live.opening, { reply_markup: this.withHome(receipt) });
    const opened =
      resolution === 'id'
        ? await this.openLiveStream.executeById({
            telegramId,
            cameraId: reference ?? '',
          })
        : await this.openLiveStream.execute({
            telegramId,
            cameraName: reference,
          });
    // A live session is external running work, not a terminal result. Keep
    // this receipt in `running` so Return Home cannot revoke the stream; the
    // eventual Home transition merely records `returned` and the watch link
    // remains usable until its own session cleanup expires it.
    const sent = await ctx.reply(live.opened(Math.max(1, Math.ceil(opened.remainingMs / 60_000))), {
      reply_markup: this.withHome(receipt, new InlineKeyboard().url(live.watchButton, opened.watchUrl)),
    });
    try {
      await opened.registerMessageReference({
        chatId,
        messageId: sent.message_id,
      });
    } catch {
      await ctx.api.deleteMessage(chatId, sent.message_id).catch(() => undefined);
      await this.liveStreamSessions.revokeUser(telegramId).catch(() => this.stopLiveStream.execute(telegramId));
      throw new Error('live message registration failed');
    }
  }
  private async handleStopLive(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    const id = ctx.from?.id;
    if (!id || !(await this.workflows.markRunning(ctx, receipt))) return;
    const name = await this.stopLiveStream.execute(id);
    await this.complete(ctx, receipt, () =>
      ctx.reply(name ? this.catalog(ctx).camera.live.stopped : this.catalog(ctx).camera.live.noActive),
    );
  }

  private async requireAdmin(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<boolean> {
    if (ctx.localeState?.user.role === 'admin') return true;
    await this.complete(ctx, receipt, () => ctx.reply(en.common.adminRequired));
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
  private async handleError(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    error: unknown,
    action: string,
  ): Promise<void> {
    const live = this.catalog(ctx).camera.live;
    if (error instanceof LiveStreamSourceUnavailableError) {
      await this.complete(ctx, receipt, () => ctx.reply(live.sourceUnavailable));
      return;
    }
    if (error instanceof LiveStreamExpiredError) {
      await this.complete(ctx, receipt, () => ctx.reply(live.expired));
      return;
    }
    if (error instanceof LiveStreamUnavailableError) {
      await this.complete(ctx, receipt, () => ctx.reply(live.unavailable));
      return;
    }
    if (error instanceof EventNotFoundError) {
      await this.complete(ctx, receipt, () => ctx.reply(en.camera.eventNotFound(error.eventId)));
      return;
    }
    this.logger.error(`${action} failed: ${(error as Error).message}`, (error as Error).stack);
    await this.complete(ctx, receipt, () => ctx.reply(en.common.error(action, (error as Error).message)));
  }
  private withHome(receipt: WorkflowReturnReceipt, keyboard = new InlineKeyboard()): InlineKeyboard {
    return keyboard
      .row()
      .text(this.catalogForReceipt(receipt).home.common.home, workflowReturnCallback(receipt.id, 'origin'));
  }
  private catalogForReceipt(receipt: WorkflowReturnReceipt): LocaleCatalog {
    return this.receiptCatalogs.get(`${receipt.userId}:${receipt.chatId}:${receipt.id}`) ?? catalogFor('en');
  }
  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }
  private remember(ctx: TelegramContext, receipt: WorkflowReturnReceipt): void {
    this.launches.set(this.key(ctx, receipt.id), receipt);
    this.receiptCatalogs.set(`${receipt.userId}:${receipt.chatId}:${receipt.id}`, this.catalog(ctx));
  }
  private key(ctx: TelegramContext, receiptId: string): string {
    return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
  }
  private inputFor(ctx: TelegramContext): BrowseInput | undefined {
    const prefix = `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:`;
    return [...this.inputs].find(([key]) => key.startsWith(prefix))?.[1];
  }
  private clearBrowse(ctx: TelegramContext, receiptId: string): void {
    const key = this.key(ctx, receiptId);
    this.inputs.delete(key);
    this.results.delete(key);
  }
  private currentResults(ctx: TelegramContext, receipt: WorkflowReturnReceipt): BrowseResults | undefined {
    const result = this.results.get(this.key(ctx, receipt.id));
    if (result && Date.now() - result.createdAtMs > CAMERA_BROWSE_TTL_MS) {
      this.results.delete(this.key(ctx, receipt.id));
      return undefined;
    }
    return result;
  }
  private currentEvent(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    id: number,
  ): BrowseMotionEvent | undefined {
    return this.currentResults(ctx, receipt)?.events.find((event) => event.id === id);
  }
  private browseNavigation(receipt: WorkflowReturnReceipt): InlineKeyboard {
    return new InlineKeyboard()
      .text(en.camera.browse.buttons.backToResults, callback(receipt.id, 'br'))
      .text(en.camera.browse.buttons.cancel, callback(receipt.id, 'bc'));
  }
  private browseResultsKeyboard(receipt: WorkflowReturnReceipt, events: BrowseMotionEvent[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const event of events)
      keyboard
        .text(en.camera.browse.eventButton(this.browseButton(event)), callback(receipt.id, `be:${event.id}`))
        .row();
    return keyboard
      .text(en.camera.browse.buttons.back, callback(receipt.id, 'bb'))
      .text(en.camera.browse.buttons.cancel, callback(receipt.id, 'bc'));
  }
  private browseLine(event: BrowseMotionEvent) {
    return {
      id: event.id,
      startedAt: event.startedAt,
      camera: event.cameraName ?? event.cameraId ?? en.camera.browse.cameraFallback,
      duration: durationLabel(event),
      media: mediaLabel(event),
    };
  }
  private browseButton(event: BrowseMotionEvent) {
    return {
      id: event.id,
      startedAt: event.startedAt,
      camera: event.cameraName ?? event.cameraId ?? en.camera.browse.cameraFallback,
      duration: durationLabel(event),
    };
  }
}

function callback(receiptId: string, action: string): string {
  const data = `cam:${receiptId}:${action}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES)
    throw new RangeError('Camera callback data exceeds Telegram limit');
  return data;
}
function parseCameraCallback(data: string): { receiptId: string; action: string } | null {
  const match = CAMERA_CALLBACK.exec(data);
  return match ? { receiptId: match[1], action: match[2] } : null;
}
function caption(delivery: Extract<VideoDelivery, { kind: 'local' }>, id: number): string {
  return en.camera.videoCaption(id, delivery.event.startedAt, delivery.event.cameraId ?? '—');
}
function durationLabel(event: MotionEvent): string {
  return en.camera.browse.duration(event.startedAt, event.endedAt, eventDurationSec(event));
}
function mediaLabel(event: MotionEvent): string {
  return en.camera.browse.media({
    hasLocalVideo: !!event.videoPath && !event.localDeleted,
    hasDriveVideo: !!event.gdriveFileId,
    hasPhoto: !!event.snapshotPath && !event.localDeleted,
  });
}
export function parseEventId(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const id = Number(value.trim());
  return Number.isInteger(id) && id > 0 ? id : null;
}
export type BrowseDateParseResult = { ok: true; date: Date; dateLabel: string } | { ok: false };
export type BrowseTimeRangeParseResult =
  | {
      ok: true;
      startHour: number;
      startMinute: number;
      endHour: number;
      endMinute: number;
      label: string;
    }
  | { ok: false; reason: 'format' | 'order' };
export function parseBrowseDateInput(text: string): BrowseDateParseResult {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!match) return { ok: false };
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return date.getFullYear() === Number(match[3]) &&
    date.getMonth() === Number(match[2]) - 1 &&
    date.getDate() === Number(match[1])
    ? { ok: true, date, dateLabel: text.trim() }
    : { ok: false };
}
export function parseTimeRangeInput(text: string): BrowseTimeRangeParseResult {
  const match = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return { ok: false, reason: 'format' };
  const values = match.slice(1).map(Number);
  if (values[0] > 23 || values[2] > 23 || values[1] > 59 || values[3] > 59) return { ok: false, reason: 'format' };
  if (values[0] * 60 + values[1] >= values[2] * 60 + values[3]) return { ok: false, reason: 'order' };
  return {
    ok: true,
    startHour: values[0],
    startMinute: values[1],
    endHour: values[2],
    endMinute: values[3],
    label: `${match[1]}:${match[2]}-${match[3]}:${match[4]}`,
  };
}
export function formatBrowseDateLabel(date: Date): string {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}
export function buildBrowseRange(
  date: Date,
  range: Extract<BrowseTimeRangeParseResult, { ok: true }>,
): { start: Date; end: Date; rangeLabel: string } {
  return {
    start: new Date(date.getFullYear(), date.getMonth(), date.getDate(), range.startHour, range.startMinute),
    end: new Date(date.getFullYear(), date.getMonth(), date.getDate(), range.endHour, range.endMinute),
    rangeLabel: range.label,
  };
}
