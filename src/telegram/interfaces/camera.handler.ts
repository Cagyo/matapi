import { Injectable, Logger } from '@nestjs/common';
import { parse } from 'date-fns';
import { Composer, Context, InlineKeyboard, InputFile } from 'grammy';
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
import { SnapshotFailedError } from '../../camera/domain/errors/snapshot-failed.error';
import { MotionEvent, eventDurationSec } from '../../camera/domain/motion-event.entity';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

type Subcommand =
  | 'snapshot'
  | 'events'
  | 'video'
  | 'photo'
  | 'enable'
  | 'disable'
  | 'status'
  | 'menu'
  | 'dashboard';

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

  constructor(
    private readonly snapshot: GetSnapshotUseCase,
    private readonly listEvents: ListMotionEventsUseCase,
    private readonly video: GetMotionVideoUseCase,
    private readonly photo: GetMotionPhotoUseCase,
    private readonly enable: EnableMotionUseCase,
    private readonly disable: DisableMotionUseCase,
    private readonly status: CameraStatusUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('camera', this.guard.registered, async (ctx) => {
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
          default:
            await ctx.reply(en.camera.usage);
        }
      } catch (err) {
        await this.handleError(ctx, err, `/camera ${sub}`);
      }
    });

    composer.callbackQuery(/^cam:/, this.guard.registered, async (ctx: Context) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      const data = (ctx.callbackQuery?.data ?? '').slice('cam:'.length).trim();
      if (!data) return;
      try {
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
        if (data === 'close') {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
          await ctx.reply(en.camera.closed);
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
  }

  async handleDashboard(ctx: Context): Promise<void> {
    const kb = new InlineKeyboard()
      .text(en.camera.dashboardButtons.snapshot, 'cam:snapshot')
      .text(en.camera.dashboardButtons.eventsToday, 'cam:events')
      .row()
      .text(en.camera.dashboardButtons.status, 'cam:status')
      .text(en.camera.dashboardButtons.close, 'cam:close');
    await ctx.reply(en.camera.dashboardTitle, { reply_markup: kb });
  }

  private async handleSnapshot(ctx: Context, name?: string): Promise<void> {
    await ctx.replyWithChatAction('upload_photo');
    const result = await this.snapshot.execute(name);
    await ctx.replyWithPhoto(new InputFile(result.buffer, 'snapshot.jpg'), {
      caption: en.camera.snapshotCaption(result.cameraName, result.takenAt),
    });
  }

  private async handleEvents(ctx: Context, dateArg?: string): Promise<void> {
    let day: Date;
    if (dateArg) {
      day = parse(dateArg, 'dd.MM.yyyy', new Date());
      if (Number.isNaN(day.getTime())) {
        await ctx.reply(en.camera.invalidDate);
        return;
      }
    } else {
      day = new Date();
    }

    const events = await this.listEvents.execute(day);
    if (events.length === 0) {
      await ctx.reply(en.camera.eventsNone(day));
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
    await ctx.reply(message, { reply_markup: kb });
  }

  private async handleVideo(ctx: Context, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null) {
      await ctx.reply(en.camera.usage);
      return;
    }

    const delivery = await this.video.execute(id);
    if (delivery.kind === 'drive') {
      await ctx.reply(en.camera.driveLinkFallback(id, driveUrl(delivery.event)));
      return;
    }

    await ctx.replyWithChatAction('upload_video');
    await ctx.replyWithVideo(new InputFile(delivery.path), {
      caption: caption(delivery, id),
    });
  }

  private async handlePhoto(ctx: Context, arg: string): Promise<void> {
    const id = parseEventId(arg);
    if (id === null) {
      await ctx.reply(en.camera.usage);
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
    });
  }

  private async handleEnable(ctx: Context): Promise<void> {
    if (!(await this.requireAdmin(ctx))) return;
    await this.enable.execute();
    await ctx.reply(en.camera.motionStarted);
  }

  private async handleDisable(ctx: Context): Promise<void> {
    if (!(await this.requireAdmin(ctx))) return;
    await this.disable.execute();
    await ctx.reply(en.camera.motionStopped);
  }

  async handleStatus(ctx: Context): Promise<void> {
    const result = await this.status.execute();
    const message = `${en.camera.statusHeader}\n\n${en.camera.statusBody(result)}`;
    await ctx.reply(message);
  }

  private async requireAdmin(ctx: Context): Promise<boolean> {
    const id = ctx.from?.id;
    const role = id ? await this.guard.resolveRole(id) : null;
    if (role !== 'admin') {
      await ctx.reply(en.common.adminRequired);
      return false;
    }
    return true;
  }

  private async handleError(ctx: Context, err: unknown, action: string): Promise<void> {
    if (err instanceof CameraNotFoundError) {
      await ctx.reply(en.camera.cameraNotFound(err.cameraName));
      return;
    }
    if (err instanceof NoCamerasConfiguredError) {
      await ctx.reply(en.camera.noCameras);
      return;
    }
    if (err instanceof MotionNotRunningError) {
      await ctx.reply(en.camera.motionNotRunning);
      return;
    }
    if (err instanceof SnapshotFailedError) {
      await ctx.reply(en.camera.snapshotFailed);
      return;
    }
    if (err instanceof EventNotFoundError) {
      await ctx.reply(en.camera.eventNotFound(err.eventId));
      return;
    }
    if (err instanceof NoSnapshotForEventError) {
      await ctx.reply(en.camera.noSnapshotForEvent(err.eventId));
      return;
    }
    if (err instanceof MediaFileUnavailableError) {
      await ctx.reply(en.camera.videoUnavailable);
      return;
    }
    if (err instanceof MotionAlreadyRunningError) {
      await ctx.reply(en.camera.alreadyRunning);
      return;
    }
    if (err instanceof MotionNotInstalledError) {
      await ctx.reply(en.camera.notInstalled);
      return;
    }
    if (err instanceof MotionStartFailedError) {
      await ctx.reply(en.camera.startFailed(err.reason));
      return;
    }
    if (err instanceof MotionStopFailedError) {
      await ctx.reply(en.camera.stopFailed(err.reason));
      return;
    }
    this.logger.error(`${action} failed: ${(err as Error).message}`, (err as Error).stack);
    await ctx.reply(en.common.error(action, (err as Error).message));
  }
}

function caption(delivery: Extract<VideoDelivery, { kind: 'local' }>, id: number): string {
  return en.camera.videoCaption(
    id,
    delivery.event.startedAt,
    delivery.event.cameraId ?? '—',
  );
}

function driveUrl(event: MotionEvent): string | null {
  return event.gdriveFileId
    ? `https://drive.google.com/file/d/${event.gdriveFileId}/view`
    : null;
}

export function parseEventId(arg: string): number | null {
  if (!/^\d+$/.test(arg.trim())) return null;
  const n = Number(arg.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
