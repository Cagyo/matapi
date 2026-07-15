import { Injectable, Logger } from '@nestjs/common';
import { parse } from 'date-fns';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { BrowseMotionEventsUseCase } from '../../camera/application/browse-motion-events.use-case';
import { CameraStatusUseCase } from '../../camera/application/camera-status.use-case';
import { DisableMotionUseCase } from '../../camera/application/disable-motion.use-case';
import { EnableMotionUseCase } from '../../camera/application/enable-motion.use-case';
import { GetMotionPhotoUseCase } from '../../camera/application/get-motion-photo.use-case';
import {
  GetMotionVideoUseCase,
  VideoDelivery,
} from '../../camera/application/get-motion-video.use-case';
import { GetSnapshotUseCase } from '../../camera/application/get-snapshot.use-case';
import { ListMotionEventsUseCase } from '../../camera/application/list-motion-events.use-case';
import { OpenLiveStreamUseCase } from '../../camera/application/open-live-stream.use-case';
import { LiveStreamSessionService } from '../../camera/application/live-stream-session.service';
import { StopLiveStreamUseCase } from '../../camera/application/stop-live-stream.use-case';
import { CameraNotFoundError } from '../../camera/domain/errors/camera-not-found.error';
import { EventNotFoundError } from '../../camera/domain/errors/event-not-found.error';
import { MediaFileUnavailableError } from '../../camera/domain/errors/media-file-unavailable.error';
import { MotionAlreadyRunningError } from '../../camera/domain/errors/motion-already-running.error';
import { MotionNotInstalledError } from '../../camera/domain/errors/motion-not-installed.error';
import { MotionNotRunningError } from '../../camera/domain/errors/motion-not-running.error';
import { MotionStartFailedError } from '../../camera/domain/errors/motion-start-failed.error';
import { MotionStopFailedError } from '../../camera/domain/errors/motion-stop-failed.error';
import { NoCamerasConfiguredError } from '../../camera/domain/errors/no-cameras-configured.error';
import { NoSnapshotForEventError } from '../../camera/domain/errors/no-snapshot-for-event.error';
import { LiveStreamExpiredError } from '../../camera/domain/errors/live-stream-expired.error';
import { LiveStreamSourceUnavailableError } from '../../camera/domain/errors/live-stream-source-unavailable.error';
import { LiveStreamUnavailableError } from '../../camera/domain/errors/live-stream-unavailable.error';
import { BrowseMotionEvent } from '../../camera/domain/ports/media-repository.port';
import { SnapshotFailedError } from '../../camera/domain/errors/snapshot-failed.error';
import { eventDurationSec, MotionEvent } from '../../camera/domain/motion-event.entity';
import { catalogFor, type LocaleCatalog } from '../../locales';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramContext } from './telegram-context';
import { TelegramHandler } from './telegram-handler';
import { CameraSourcesHandler } from './camera-sources.handler';
import {
  appendReturnHomeButton,
  returnHomeKeyboard,
  type ExternalWorkflowPhase,
} from './return-home';

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

const CAMERA_BROWSE_TTL_MS = 10 * 60_000;

type CameraBrowsePendingInput =
  | { kind: 'awaiting-date'; createdAtMs: number }
  | {
      kind: 'awaiting-range';
      selectedDate: Date;
      promptLabel: string;
      dateLabel: string;
      createdAtMs: number;
    };

interface CameraBrowseLastResults {
  events: BrowseMotionEvent[];
  header: string;
  hasMore: boolean;
  createdAtMs: number;
}

/**
 * `/camera <subcommand>` — spec 14.
 *
 * Registered for any registered user; `enable`/`disable` additionally
 * require an admin role (checked inline since the command-level guard only
 * enforces registration). All domain errors are mapped to locale strings.
 */
@Injectable()
export class CameraHandler implements TelegramHandler {
  private readonly logger = new Logger(CameraHandler.name);
  private readonly pendingBrowseInputs = new Map<number, CameraBrowsePendingInput>();
  private readonly browseLastResults = new Map<number, CameraBrowseLastResults>();

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
  ) {}

  cancelPending(userId: number, chatId: number): void {
    this.pendingBrowseInputs.delete(userId);
    this.browseLastResults.delete(userId);
    this.sources.cancelPending(userId, chatId);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('camera', this.guard.registered, async (ctx) => {
      if (!ctx.from || !ctx.message || ctx.chat?.type !== 'private') return;
      this.cancelPending(ctx.from.id, ctx.chat.id);
      const tokens = (ctx.match ?? '').toString().trim().split(/\s+/).filter(Boolean);
      const sub = (tokens.shift() ?? '').toLowerCase() as Subcommand | '';
      const arg = tokens.join(' ').trim();

      try {
        switch (sub) {
          case '':
          case 'menu':
          case 'dashboard':
            await this.handleDashboard(ctx);
            return;
          case 'snapshot':
            await this.handleSnapshot(ctx, arg || undefined);
            return;
          case 'events':
            await this.handleEvents(ctx, arg || undefined);
            return;
          case 'video':
            await this.handleVideo(ctx, arg);
            return;
          case 'photo':
            await this.handlePhoto(ctx, arg);
            return;
          case 'enable':
            await this.handleEnable(ctx);
            return;
          case 'disable':
            await this.handleDisable(ctx);
            return;
          case 'status':
            await this.handleStatus(ctx);
            return;
          case 'live':
            await this.handleLive(ctx, arg || undefined);
            return;
          case 'stop_stream':
            await this.handleStopLive(ctx);
            return;
          case 'sources':
            await this.sources.handleEntry(ctx);
            return;
          default:
            await ctx.reply(en.camera.usage, {
              reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
            });
        }
      } catch (err) {
        await this.handleError(ctx, err, `/camera ${sub}`);
      }
    });

    composer.callbackQuery(/^cam:/, this.guard.registered, async (ctx: TelegramContext) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (ctx.chat?.type !== 'private') return;
      const data = (ctx.callbackQuery?.data ?? '').slice('cam:'.length).trim();
      if (!data) return;
      try {
        if (data === 'browse' || data.startsWith('browse:')) {
          this.sources.cancelPending(userId, ctx.chat.id);
        } else if (data === 'sources' || data.startsWith('sources:')) {
          this.clearAllBrowseState(ctx);
        } else {
          this.cancelPending(userId, ctx.chat.id);
        }
        if (data === 'sources') {
          await this.sources.handleEntry(ctx);
          return;
        }
        if (data.startsWith('sources:')) {
          await this.sources.handleCallback(ctx, data.slice('sources:'.length));
          return;
        }
        if (data === 'snapshot') {
          await this.handleSnapshot(ctx);
          return;
        }
        if (data === 'events') {
          await this.handleEvents(ctx);
          return;
        }
        if (data === 'status') {
          await this.handleStatus(ctx);
          return;
        }
        if (data === 'live') {
          await this.handleLive(ctx);
          return;
        }
        if (data.startsWith('live:')) {
          const cameraId = data.slice('live:'.length).trim();
          if (cameraId) await this.handleLive(ctx, cameraId, 'id');
          return;
        }
        if (data === 'close') {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
          await ctx.reply(en.camera.closed, {
            reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
          });
          return;
        }
        if (data === 'browse') {
          await this.handleBrowseMenu(ctx);
          return;
        }
        if (data === 'browse:today') {
          await this.handleBrowseRelativeDate(ctx, 'today');
          return;
        }
        if (data === 'browse:yesterday') {
          await this.handleBrowseRelativeDate(ctx, 'yesterday');
          return;
        }
        if (data === 'browse:pick-date') {
          await this.handleBrowsePickDate(ctx);
          return;
        }
        if (data === 'browse:latest') {
          await this.handleBrowseLatest(ctx);
          return;
        }
        if (data.startsWith('browse:event:')) {
          await this.handleBrowseEvent(ctx, data.slice('browse:event:'.length));
          return;
        }
        if (data.startsWith('browse:video:')) {
          await this.handleBrowseVideo(ctx, data.slice('browse:video:'.length));
          return;
        }
        if (data.startsWith('browse:photo:')) {
          await this.handleBrowsePhoto(ctx, data.slice('browse:photo:'.length));
          return;
        }
        if (data === 'browse:back-results') {
          await this.handleBrowseBackResults(ctx);
          return;
        }
        if (data === 'browse:back') {
          await this.handleBrowseBack(ctx);
          return;
        }
        if (data === 'browse:cancel') {
          this.clearAllBrowseState(ctx);
          await ctx.reply(en.camera.browse.cancelled, {
            reply_markup: this.returnKeyboard(ctx, 'alreadyTerminal'),
          });
          return;
        }
        if (data === 'browse:close') {
          this.clearAllBrowseState(ctx);
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
          await ctx.reply(en.camera.closed, {
            reply_markup: this.returnKeyboard(ctx, 'alreadyTerminal'),
          });
          return;
        }
        if (data.startsWith('video:')) {
          const idStr = data.slice('video:'.length);
          await this.handleVideo(ctx, idStr);
          return;
        }
        if (data.startsWith('photo:')) {
          const idStr = data.slice('photo:'.length);
          await this.handlePhoto(ctx, idStr);
          return;
        }
      } catch (err) {
        await this.handleError(ctx, err, `/camera callback (${data})`);
      }
    });

    composer.on('message:text', this.guard.registered, async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId) return next();
      if (ctx.message?.text?.startsWith('/')) return next();
      try {
        if (await this.sources.handleText(ctx)) return;
        if (!this.pendingBrowseInputs.has(userId)) return next();
        await this.handleBrowseText(ctx, userId, ctx.message.text.trim());
      } catch (err) {
        await this.handleError(ctx, err, '/camera browse text');
      }
    });
  }

  async handleDashboard(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.type === 'private' ? ctx.chat.id : undefined;
    if (userId !== undefined && chatId !== undefined) this.cancelPending(userId, chatId);

    const kb = new InlineKeyboard()
      .text(this.catalog(ctx).camera.dashboardButtons.live, 'cam:live')
      .row()
      .text(en.camera.dashboardButtons.snapshot, 'cam:snapshot')
      .text(en.camera.dashboardButtons.browseEvents, 'cam:browse')
      .row()
      .text(en.camera.dashboardButtons.eventsToday, 'cam:events')
      .text(en.camera.dashboardButtons.status, 'cam:status')
      .row()
      .text(en.camera.dashboardButtons.close, 'cam:close');
    await ctx.reply(en.camera.dashboardTitle, {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', kb),
    });
  }

  private async handleBrowseMenu(ctx: TelegramContext): Promise<void> {
    this.clearBrowseInput(ctx);
    this.clearBrowseResults(ctx);

    const kb = new InlineKeyboard()
      .text(en.camera.browse.buttons.today, 'cam:browse:today')
      .text(en.camera.browse.buttons.yesterday, 'cam:browse:yesterday')
      .row()
      .text(en.camera.browse.buttons.pickDate, 'cam:browse:pick-date')
      .text(en.camera.browse.buttons.latest, 'cam:browse:latest')
      .row()
      .text(en.camera.browse.buttons.back, 'cam:browse:back')
      .text(en.camera.browse.buttons.close, 'cam:browse:close');
    await ctx.reply(en.camera.browse.menuTitle, {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', kb),
    });
  }

  private async handleBrowsePickDate(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    this.clearAllBrowseState(ctx);
    this.pendingBrowseInputs.set(userId, {
      kind: 'awaiting-date',
      createdAtMs: Date.now(),
    });
    await ctx.reply(en.camera.browse.datePrompt, {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', browseBackCancelKeyboard()),
    });
  }

  private async handleBrowseRelativeDate(
    ctx: TelegramContext,
    mode: 'today' | 'yesterday',
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const selectedDate = new Date();
    if (mode === 'yesterday') selectedDate.setDate(selectedDate.getDate() - 1);
    const promptLabel = mode;
    const dateLabel = formatBrowseDateLabel(selectedDate);

    this.clearAllBrowseState(ctx);
    this.pendingBrowseInputs.set(userId, {
      kind: 'awaiting-range',
      selectedDate,
      promptLabel,
      dateLabel,
      createdAtMs: Date.now(),
    });
    await ctx.reply(en.camera.browse.timeRangePrompt(promptLabel), {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', browseBackCancelKeyboard()),
    });
  }

  private async handleBrowseText(
    ctx: TelegramContext,
    userId: number,
    text: string,
  ): Promise<void> {
    const state = this.pendingBrowseInputs.get(userId);
    if (!state) return;
    if (Date.now() - state.createdAtMs > CAMERA_BROWSE_TTL_MS) {
      this.clearAllBrowseState(ctx);
      await ctx.reply(en.camera.browse.expiredInput, {
        reply_markup: this.returnKeyboard(ctx, 'alreadyTerminal'),
      });
      return;
    }

    if (state.kind === 'awaiting-date') {
      const parsedDate = parseBrowseDateInput(text);
      if (!parsedDate.ok) {
        await ctx.reply(en.camera.browse.invalidDate, {
          reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx), browseBackCancelKeyboard()),
        });
        return;
      }
      this.pendingBrowseInputs.set(userId, {
        kind: 'awaiting-range',
        selectedDate: parsedDate.date,
        promptLabel: parsedDate.dateLabel,
        dateLabel: parsedDate.dateLabel,
        createdAtMs: Date.now(),
      });
      await ctx.reply(en.camera.browse.timeRangePrompt(parsedDate.dateLabel), {
        reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx), browseBackCancelKeyboard()),
      });
      return;
    }

    const parsedRange = parseTimeRangeInput(text);
    if (!parsedRange.ok) {
      await ctx.reply(
        parsedRange.reason === 'order'
          ? en.camera.browse.invalidTimeOrder
          : en.camera.browse.invalidTimeRange,
        { reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx), browseBackCancelKeyboard()) },
      );
      return;
    }

    const range = buildBrowseRange(state.selectedDate, parsedRange);
    this.pendingBrowseInputs.delete(userId);
    const result = await this.browseEvents.between(range.start, range.end);
    await this.replyBrowseResults(ctx, {
      kind: 'range',
      events: result.events,
      hasMore: result.hasMore,
      dateLabel: state.dateLabel,
      rangeLabel: range.rangeLabel,
    });
  }

  private async handleBrowseLatest(ctx: TelegramContext): Promise<void> {
    this.clearBrowseInput(ctx);
    const result = await this.browseEvents.latest();
    await this.replyBrowseResults(ctx, {
      kind: 'latest',
      events: result.events,
      hasMore: result.hasMore,
    });
  }

  private async replyBrowseResults(
    ctx: TelegramContext,
    result:
      | {
          kind: 'latest';
          events: BrowseMotionEvent[];
          hasMore: boolean;
        }
      | {
          kind: 'range';
          events: BrowseMotionEvent[];
          hasMore: boolean;
          dateLabel: string;
          rangeLabel: string;
        },
  ): Promise<void> {
    if (result.events.length === 0) {
      const empty =
        result.kind === 'latest'
          ? en.camera.browse.emptyLatest
          : en.camera.browse.emptyRange(result.dateLabel, result.rangeLabel);
      const userId = ctx.from?.id;
      if (userId) {
        this.browseLastResults.set(userId, {
          events: [],
          header: '',
          hasMore: result.hasMore,
          createdAtMs: Date.now(),
        });
      }
      await ctx.reply(empty, {
        reply_markup: this.returnKeyboard(ctx, 'cancelPending', browseResultNavKeyboard()),
      });
      return;
    }

    const header =
      result.kind === 'latest'
        ? en.camera.browse.latestHeader(result.events.length)
        : en.camera.browse.rangeHeader(
            result.dateLabel,
            result.rangeLabel,
            result.events.length,
            result.hasMore,
          );
    const lines = result.events.map((event) =>
      en.camera.browse.eventLine(this.toBrowseLineView(event)),
    );
    const message = [header, '', ...lines].join('\n');
    const userId = ctx.from?.id;
    if (userId) {
      this.browseLastResults.set(userId, {
        events: result.events,
        header,
        hasMore: result.hasMore,
        createdAtMs: Date.now(),
      });
    }
    await ctx.reply(message, {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', this.browseResultsKeyboard(result.events)),
    });
  }

  private browseResultsKeyboard(events: BrowseMotionEvent[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const event of events) {
      kb.text(
        en.camera.browse.eventButton(this.toBrowseButtonView(event)),
        `cam:browse:event:${event.id}`,
      ).row();
    }
    kb.text(en.camera.browse.buttons.back, 'cam:browse:back')
      .text(en.camera.browse.buttons.close, 'cam:browse:close');
    return kb;
  }

  private toBrowseLineView(event: BrowseMotionEvent) {
    return {
      id: event.id,
      startedAt: event.startedAt,
      camera: cameraName(event),
      duration: durationLabel(event),
      media: mediaLabel(event),
    };
  }

  private toBrowseButtonView(event: BrowseMotionEvent) {
    return {
      id: event.id,
      startedAt: event.startedAt,
      camera: cameraName(event),
      duration: durationLabel(event),
    };
  }

  private async handleBrowseBack(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    const hadPending = userId ? this.pendingBrowseInputs.has(userId) : false;
    const hadCachedResults = userId ? this.browseLastResults.has(userId) : false;
    const results = userId ? this.currentBrowseResults(userId) : undefined;
    const hadExpiredResults = hadCachedResults && !results;

    if (userId) {
      this.pendingBrowseInputs.delete(userId);
      this.browseLastResults.delete(userId);
    }

    if (hadExpiredResults) {
      await this.replyBrowseResultsExpired(ctx);
      return;
    }

    if (hadPending || results) {
      await this.handleBrowseMenu(ctx);
      return;
    }

    await this.handleDashboard(ctx);
  }

  private async handleBrowseEvent(ctx: TelegramContext, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null) {
      await this.replyBrowseResultsExpired(ctx);
      return;
    }
    const results = this.currentBrowseResults(ctx.from?.id ?? -1);
    if (!results || results.events.length === 0) {
      await this.replyBrowseResultsExpired(ctx);
      return;
    }
    const event = results.events.find((candidate) => candidate.id === id);
    if (!event) {
      await this.handleError(ctx, new EventNotFoundError(id), '/camera browse event');
      return;
    }

    const keyboard = new InlineKeyboard();
    const hasVideo = (!!event.videoPath && !event.localDeleted) || !!event.gdriveFileId;
    const hasPhoto = !!event.snapshotPath && !event.localDeleted;
    if (hasVideo) keyboard.text(en.camera.browse.buttons.video, `cam:browse:video:${event.id}`);
    if (hasPhoto) keyboard.text(en.camera.browse.buttons.photo, `cam:browse:photo:${event.id}`);
    if (hasVideo || hasPhoto) keyboard.row();
    keyboard
      .text(en.camera.browse.buttons.backToResults, 'cam:browse:back-results')
      .text(en.camera.browse.buttons.close, 'cam:browse:close');
    await ctx.reply(en.camera.browse.actionHeader(this.toBrowseLineView(event)), {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', keyboard),
    });
  }

  private async handleBrowseVideo(ctx: TelegramContext, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null || !this.currentBrowseEvent(ctx, id)) {
      await this.replyBrowseResultsExpired(ctx);
      return;
    }
    const delivery = await this.video.execute(id);
    const keyboard = this.browseMediaKeyboard(ctx);
    if (delivery.kind === 'drive') {
      await ctx.reply(en.camera.driveLinkFallback(id, delivery.event.gdriveFileId), {
        reply_markup: keyboard,
      });
      return;
    }
    await ctx.replyWithChatAction('upload_video');
    await ctx.replyWithVideo(new InputFile(delivery.path), {
      caption: caption(delivery, id),
      reply_markup: keyboard,
    });
  }

  private async handleBrowsePhoto(ctx: TelegramContext, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null || !this.currentBrowseEvent(ctx, id)) {
      await this.replyBrowseResultsExpired(ctx);
      return;
    }
    await ctx.replyWithChatAction('upload_photo');
    const result = await this.photo.execute(id);
    await ctx.replyWithPhoto(new InputFile(result.path), {
      caption: en.camera.photoCaption(
        result.event.id,
        result.event.startedAt,
        result.event.cameraId ?? '—',
      ),
      reply_markup: this.browseMediaKeyboard(ctx),
    });
  }

  private async handleBrowseBackResults(ctx: TelegramContext): Promise<void> {
    const results = this.currentBrowseResults(ctx.from?.id ?? -1);
    if (!results || results.events.length === 0) {
      await this.replyBrowseResultsExpired(ctx);
      return;
    }
    const lines = results.events.map((event) => en.camera.browse.eventLine(this.toBrowseLineView(event)));
    await ctx.reply([results.header, '', ...lines].join('\n'), {
      reply_markup: this.returnKeyboard(ctx, 'cancelPending', this.browseResultsKeyboard(results.events)),
    });
  }

  private currentBrowseEvent(ctx: TelegramContext, id: number): BrowseMotionEvent | undefined {
    return this.currentBrowseResults(ctx.from?.id ?? -1)?.events.find((event) => event.id === id);
  }

  private async replyBrowseResultsExpired(ctx: TelegramContext): Promise<void> {
    this.clearAllBrowseState(ctx);
    await ctx.reply(en.camera.browse.resultsExpired, {
      reply_markup: this.returnKeyboard(
        ctx,
        'alreadyTerminal',
        new InlineKeyboard().text(en.camera.dashboardButtons.browseEvents, 'cam:browse'),
      ),
    });
  }

  private browseMediaKeyboard(ctx: TelegramContext): InlineKeyboard {
    return this.returnKeyboard(
      ctx,
      'cancelPending',
      new InlineKeyboard()
        .text(en.camera.browse.buttons.backToResults, 'cam:browse:back-results')
        .text(en.camera.browse.buttons.close, 'cam:browse:close'),
    );
  }

  private clearBrowseInput(ctx: TelegramContext): void {
    const userId = ctx.from?.id;
    if (!userId) return;
    this.pendingBrowseInputs.delete(userId);
  }

  private clearBrowseResults(ctx: TelegramContext): void {
    const userId = ctx.from?.id;
    if (!userId) return;
    this.browseLastResults.delete(userId);
  }

  private clearAllBrowseState(ctx: TelegramContext): void {
    this.clearBrowseInput(ctx);
    this.clearBrowseResults(ctx);
  }

  private currentBrowseResults(userId: number): CameraBrowseLastResults | undefined {
    const state = this.browseLastResults.get(userId);
    if (state && Date.now() - state.createdAtMs > CAMERA_BROWSE_TTL_MS) {
      this.browseLastResults.delete(userId);
      return undefined;
    }
    return state;
  }

  private returnKeyboard(
    ctx: TelegramContext,
    phase: ExternalWorkflowPhase,
    keyboard?: InlineKeyboard,
  ): InlineKeyboard {
    const input = { workflow: 'camera' as const, phase };
    return keyboard
      ? appendReturnHomeButton(keyboard, this.catalog(ctx), input)
      : returnHomeKeyboard(this.catalog(ctx), input);
  }

  private returnPhase(ctx: TelegramContext): ExternalWorkflowPhase {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.type === 'private' ? ctx.chat.id : undefined;
    return userId !== undefined && chatId !== undefined &&
      (this.pendingBrowseInputs.has(userId) ||
        this.currentBrowseResults(userId) !== undefined ||
        this.sources.hasPending(userId, chatId))
      ? 'cancelPending'
      : 'alreadyTerminal';
  }

  private async handleSnapshot(ctx: TelegramContext, name?: string): Promise<void> {
    await ctx.replyWithChatAction('upload_photo');
    const result = await this.snapshot.execute(name);
    await ctx.replyWithPhoto(new InputFile(result.buffer, 'snapshot.jpg'), {
      caption: en.camera.snapshotCaption(result.cameraName, result.takenAt),
      reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
    });
  }

  private async handleEvents(ctx: TelegramContext, dateArg?: string): Promise<void> {
    let day: Date;
    if (dateArg) {
      day = parse(dateArg, 'dd.MM.yyyy', new Date());
      if (Number.isNaN(day.getTime())) {
        await ctx.reply(en.camera.invalidDate, {
          reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
        });
        return;
      }
    } else {
      day = new Date();
    }

    const events = await this.listEvents.execute(day);
    if (events.length === 0) {
      await ctx.reply(en.camera.eventsNone(day), {
        reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
      });
      return;
    }

    const lines = events.map((e) =>
      en.camera.eventLine({
        id: e.id,
        startedAt: e.startedAt,
        durationSec: eventDurationSec(e),
        hasSnapshot: !!e.snapshotPath,
      }),
    );
    const message = [
      en.camera.eventsHeader(day),
      ...lines,
      '',
      en.camera.eventsFooter(events.length),
    ].join('\n');

    const kb = new InlineKeyboard();
    const recent = events.slice(0, 5);
    for (const e of recent) {
      kb.text(en.camera.eventButtons.video(e.id), `cam:video:${e.id}`);
      if (e.snapshotPath) {
        kb.text(en.camera.eventButtons.photo(e.id), `cam:photo:${e.id}`);
      }
      kb.row();
    }
    await ctx.reply(message, {
      reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx), kb),
    });
  }

  private async handleVideo(ctx: TelegramContext, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null) {
      await ctx.reply(en.camera.usage, {
        reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
      });
      return;
    }

    const delivery = await this.video.execute(id);
    if (delivery.kind === 'drive') {
      // gdriveFileId holds the rclone remote path (not a Drive file id).
      await ctx.reply(en.camera.driveLinkFallback(id, delivery.event.gdriveFileId), {
        reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
      });
      return;
    }

    await ctx.replyWithChatAction('upload_video');
    await ctx.replyWithVideo(new InputFile(delivery.path), {
      caption: caption(delivery, id),
      reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
    });
  }

  private async handlePhoto(ctx: TelegramContext, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null) {
      await ctx.reply(en.camera.usage, {
        reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
      });
      return;
    }

    await ctx.replyWithChatAction('upload_photo');
    const result = await this.photo.execute(id);
    await ctx.replyWithPhoto(new InputFile(result.path), {
      caption: en.camera.photoCaption(
        result.event.id,
        result.event.startedAt,
        result.event.cameraId ?? '—',
      ),
      reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
    });
  }

  private async handleEnable(ctx: TelegramContext): Promise<void> {
    if (!(await this.requireAdmin(ctx))) return;
    await this.enable.execute();
    await ctx.reply(en.camera.motionStarted, {
      reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
    });
  }

  private async handleDisable(ctx: TelegramContext): Promise<void> {
    if (!(await this.requireAdmin(ctx))) return;
    await this.disable.execute();
    await ctx.reply(en.camera.motionStopped, {
      reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)),
    });
  }

  async handleStatus(ctx: TelegramContext): Promise<void> {
    const result = await this.status.execute();
    const message = `${en.camera.statusHeader}\n\n${en.camera.statusBody(result)}`;
    await ctx.reply(message, { reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)) });
  }

  private async handleLive(
    ctx: TelegramContext,
    cameraReference?: string,
    resolution: 'name' | 'id' = 'name',
  ): Promise<void> {
    const telegramId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!telegramId || chatId === undefined || ctx.chat?.type !== 'private') return;
    const catalog = this.catalog(ctx);

    await ctx.reply(catalog.camera.live.opening);
    try {
      const opened = resolution === 'id'
        ? await this.openLiveStream.executeById({
            telegramId,
            cameraId: cameraReference ?? '',
          })
        : await this.openLiveStream.execute({
            telegramId,
            cameraName: cameraReference,
          });
      const keyboard = new InlineKeyboard().url(
        catalog.camera.live.watchButton,
        opened.watchUrl,
      );
      const sent = await ctx.reply(
        catalog.camera.live.opened(
          Math.max(1, Math.ceil(opened.remainingMs / 60_000)),
        ),
        { reply_markup: keyboard },
      );
      try {
        await opened.registerMessageReference({
          chatId,
          messageId: sent.message_id,
        });
      } catch (error) {
        await this.compensateFailedLiveMessage(ctx, telegramId, chatId, sent.message_id);
        throw error;
      }
    } catch (error) {
      await this.handleLiveError(ctx, error, 'open live stream');
    }
  }

  private async compensateFailedLiveMessage(
    ctx: TelegramContext,
    telegramId: number,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    await ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
    try {
      await this.liveStreamSessions.revokeUser(telegramId);
    } catch {
      await this.stopLiveStream.execute(telegramId);
    }
  }

  private async handleStopLive(ctx: TelegramContext): Promise<void> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    const catalog = this.catalog(ctx);
    try {
      const cameraName = await this.stopLiveStream.execute(telegramId);
      await ctx.reply(
        cameraName ? catalog.camera.live.stopped : catalog.camera.live.noActive,
      );
    } catch (error) {
      await this.handleLiveError(ctx, error, 'stop live stream');
    }
  }

  private async handleLiveError(
    ctx: TelegramContext,
    error: unknown,
    action: string,
  ): Promise<void> {
    const live = this.catalog(ctx).camera.live;
    if (error instanceof LiveStreamSourceUnavailableError) {
      await ctx.reply(live.sourceUnavailable);
      return;
    }
    if (error instanceof LiveStreamExpiredError) {
      await ctx.reply(live.expired);
      return;
    }
    if (error instanceof LiveStreamUnavailableError) {
      await ctx.reply(live.unavailable);
      return;
    }
    this.logger.error(`${action} failed`);
    await ctx.reply(live.unavailable);
  }

  private catalog(ctx: TelegramContext): LocaleCatalog {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

  private async requireAdmin(ctx: TelegramContext): Promise<boolean> {
    if (ctx.localeState?.user.role !== 'admin') {
      await ctx.reply(en.common.adminRequired);
      return false;
    }
    return true;
  }

  private async handleError(ctx: TelegramContext, err: unknown, action: string): Promise<void> {
    if (err instanceof CameraNotFoundError) {
      await this.replyWithReturnHome(ctx, en.camera.cameraNotFound(err.cameraName));
      return;
    }
    if (err instanceof NoCamerasConfiguredError) {
      await this.replyWithReturnHome(ctx, en.camera.noCameras);
      return;
    }
    if (err instanceof MotionNotRunningError) {
      await this.replyWithReturnHome(ctx, en.camera.motionNotRunning);
      return;
    }
    if (err instanceof SnapshotFailedError) {
      await this.replyWithReturnHome(ctx, en.camera.snapshotFailed);
      return;
    }
    if (err instanceof EventNotFoundError) {
      await this.replyWithReturnHome(ctx, en.camera.eventNotFound(err.eventId));
      return;
    }
    if (err instanceof NoSnapshotForEventError) {
      await this.replyWithReturnHome(ctx, en.camera.noSnapshotForEvent(err.eventId));
      return;
    }
    if (err instanceof MediaFileUnavailableError) {
      await this.replyWithReturnHome(ctx, en.camera.videoUnavailable);
      return;
    }
    if (err instanceof MotionAlreadyRunningError) {
      await this.replyWithReturnHome(ctx, en.camera.alreadyRunning);
      return;
    }
    if (err instanceof MotionNotInstalledError) {
      await this.replyWithReturnHome(ctx, en.camera.notInstalled);
      return;
    }
    if (err instanceof MotionStartFailedError) {
      await this.replyWithReturnHome(ctx, en.camera.startFailed(err.reason));
      return;
    }
    if (err instanceof MotionStopFailedError) {
      await this.replyWithReturnHome(ctx, en.camera.stopFailed(err.reason));
      return;
    }
    this.logger.error(`${action} failed: ${(err as Error).message}`, (err as Error).stack);
    await this.replyWithReturnHome(ctx, en.common.error(action, (err as Error).message));
  }

  private async replyWithReturnHome(ctx: TelegramContext, message: string): Promise<void> {
    await ctx.reply(message, { reply_markup: this.returnKeyboard(ctx, this.returnPhase(ctx)) });
  }
}

function caption(delivery: Extract<VideoDelivery, { kind: 'local' }>, id: number): string {
  return en.camera.videoCaption(
    id,
    delivery.event.startedAt,
    delivery.event.cameraId ?? '—',
  );
}

function browseBackCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(en.camera.browse.buttons.back, 'cam:browse:back')
    .text(en.camera.browse.buttons.cancel, 'cam:browse:cancel');
}

function browseResultNavKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(en.camera.browse.buttons.back, 'cam:browse:back')
    .text(en.camera.browse.buttons.close, 'cam:browse:close');
}

function cameraName(event: BrowseMotionEvent): string {
  return event.cameraName ?? event.cameraId ?? en.camera.browse.cameraFallback;
}

function durationLabel(event: MotionEvent): string {
  return en.camera.browse.duration(
    event.startedAt,
    event.endedAt,
    eventDurationSec(event),
  );
}

function mediaLabel(event: MotionEvent): string {
  return en.camera.browse.media({
    hasLocalVideo: !!event.videoPath && !event.localDeleted,
    hasDriveVideo: !!event.gdriveFileId,
    hasPhoto: !!event.snapshotPath && !event.localDeleted,
  });
}

export function parseEventId(arg: string): number | null {
  if (!/^\d+$/.test(arg.trim())) return null;
  const n = Number(arg.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export type BrowseDateParseResult =
  | { ok: true; date: Date; dateLabel: string }
  | { ok: false };

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

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    date,
    dateLabel: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function parseTimeRangeInput(text: string): BrowseTimeRangeParseResult {
  const match = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return { ok: false, reason: 'format' };

  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);

  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return { ok: false, reason: 'format' };
  }

  const startTotal = startHour * 60 + startMinute;
  const endTotal = endHour * 60 + endMinute;
  if (endTotal <= startTotal) return { ok: false, reason: 'order' };

  return {
    ok: true,
    startHour,
    startMinute,
    endHour,
    endMinute,
    label: `${match[1]}:${match[2]}-${match[3]}:${match[4]}`,
  };
}

export function buildBrowseRange(
  selectedDate: Date,
  range: Extract<BrowseTimeRangeParseResult, { ok: true }>,
): { start: Date; end: Date; rangeLabel: string } {
  return {
    start: new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate(),
      range.startHour,
      range.startMinute,
    ),
    end: new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate(),
      range.endHour,
      range.endMinute,
    ),
    rangeLabel: range.label,
  };
}

export function formatBrowseDateLabel(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getFullYear()}`;
}
