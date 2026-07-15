import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { catalogFor } from '../../locales';
import { en, TYPE_ICONS } from '../../locales/en';
import {
  SENSOR_LOG_REPOSITORY,
  SensorLogEntry,
  SensorLogRepositoryPort,
} from '../../sensors/domain/ports/sensor-log-repository.port';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import {
  returnHomeKeyboard,
  type ExternalWorkflowPhase,
} from './return-home';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

const TELEGRAM_MAX_MESSAGE = 4096;
const DEFAULT_COUNT = 20;
const MAX_COUNT = 1000;

interface ParsedArgs {
  name: string;
  count: number;
  since?: Date;
  invalid?: 'count' | 'duration';
}

/**
 * `/logs <sensor> [count]` or `/logs <sensor> --since <duration>` — spec 09.
 *
 * - Active-then-archive name resolution via `SensorQueryPort.findByName`.
 * - Output goes inline when ≤ 4096 chars, otherwise as a `.txt` attachment.
 */
@Injectable()
export class LogsHandler implements TelegramHandler {
  private readonly logger = new Logger(LogsHandler.name);

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(SENSOR_LOG_REPOSITORY)
    private readonly logs: SensorLogRepositoryPort,
    private readonly guard: RoleMiddleware,
  ) {}

  async handleEmpty(ctx: TelegramContext): Promise<void> {
    const sensors = await this.sensors.listEnabled();
    if (sensors.length === 0) {
      await this.replyTerminal(ctx, en.status.none);
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of sensors) {
      const icon = TYPE_ICONS[s.type] ?? '•';
      kb.text(`${icon} ${s.name}`, `logs:${s.name}`).row();
    }
    kb.append(this.keyboard(ctx, 'cancelPending'));
    await ctx.reply(en.logs.selectSensor, { reply_markup: kb });
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('logs', this.guard.registered, async (ctx) => {
      const raw = (ctx.match ?? '').toString().trim();
      if (!raw) {
        await this.handleEmpty(ctx);
        return;
      }

      const parsed = parseArgs(raw);
      if (parsed.invalid === 'count') {
        await this.replyTerminal(ctx, en.logs.invalidCount);
        return;
      }
      if (parsed.invalid === 'duration') {
        await this.replyTerminal(ctx, en.logs.invalidDuration);
        return;
      }

      try {
        const lookup = await this.sensors.findByName(parsed.name);
        if (!lookup) {
          await this.replyTerminal(ctx, en.logs.notFound(parsed.name));
          return;
        }

        const entries = await this.logs.findRecent(lookup.sensor.id, {
          limit: parsed.count,
          since: parsed.since,
        });

        if (entries.length === 0) {
          await this.replyTerminal(ctx, en.logs.none(parsed.name));
          return;
        }

        await this.deliver(ctx, parsed.name, entries);
      } catch (err) {
        this.logger.error(
          `/logs failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await this.replyTerminal(ctx, en.logs.readFailed);
      }
    });

    composer.callbackQuery(/^logs:/, this.guard.registered, async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      const target = (ctx.callbackQuery?.data ?? '').slice('logs:'.length).trim();
      if (!target) return;
      try {
        const lookup = target.startsWith('id:')
          ? await this.sensors.findByIdIncludingArchived(target.slice('id:'.length))
          : await this.sensors.findByName(target);
        if (!lookup) {
          await this.replyTerminal(
            ctx,
            en.logs.notFound(target.startsWith('id:') ? 'selected sensor' : target),
          );
          return;
        }
        const sensor = lookup.sensor;
        const entries = await this.logs.findRecent(sensor.id, {
          limit: DEFAULT_COUNT,
        });
        if (entries.length === 0) {
          await this.replyTerminal(ctx, en.logs.none(sensor.name));
          return;
        }
        await this.deliver(ctx, sensor.name, entries);
      } catch (err) {
        this.logger.error(
          `/logs callback failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        await this.replyTerminal(ctx, en.logs.readFailed);
      }
    });
  }

  private keyboard(
    ctx: TelegramContext,
    phase: ExternalWorkflowPhase,
  ): InlineKeyboard {
    return returnHomeKeyboard(ctx.localeState?.catalog ?? catalogFor('en'), {
      workflow: 'logs',
      phase,
    });
  }

  private async replyTerminal(ctx: TelegramContext, text: string): Promise<void> {
    await ctx.reply(text, {
      reply_markup: this.keyboard(ctx, 'alreadyTerminal'),
    });
  }

  private async deliver(
    ctx: TelegramContext,
    name: string,
    entries: SensorLogEntry[],
  ): Promise<void> {
    const header = en.logs.header(name, entries.length);
    const body = entries.map((e) => en.logs.line(e)).join('\n');
    const message = `${header}\n\n${body}`;

    if (message.length <= TELEGRAM_MAX_MESSAGE) {
      await this.replyTerminal(ctx, message);
      return;
    }

    const file = new InputFile(Buffer.from(message, 'utf8'), en.logs.fileName(name));
    await ctx.replyWithDocument(file, {
      caption: header,
      reply_markup: this.keyboard(ctx, 'alreadyTerminal'),
    });
  }

}

export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const name = tokens.shift() ?? '';

  let count = DEFAULT_COUNT;
  let since: Date | undefined;
  let invalid: ParsedArgs['invalid'];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '--since' || tok === '-s') {
      const value = tokens[i + 1];
      const ms = parseDuration(value);
      if (ms === null) {
        invalid = 'duration';
        break;
      }
      since = new Date(Date.now() - ms);
      // When `--since` is supplied, default to a generous cap so the user
      // sees the whole window instead of the default 20.
      count = MAX_COUNT;
      i += 1;
    } else if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (!Number.isInteger(n) || n <= 0 || n > MAX_COUNT) {
        invalid = 'count';
        break;
      }
      count = n;
    } else {
      invalid = 'count';
      break;
    }
  }

  return { name, count, since, invalid };
}

export function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  const ms =
    unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * ms;
}
