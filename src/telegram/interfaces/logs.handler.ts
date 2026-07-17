import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { en, TYPE_ICONS } from '../../locales/en';
import {
  SENSOR_LOG_REPOSITORY,
  SensorLogEntry,
  SensorLogRepositoryPort,
} from '../../sensors/domain/ports/sensor-log-repository.port';
import { SENSOR_QUERY, SensorQueryPort } from '../../sensors/domain/ports/sensor-query.port';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

const TELEGRAM_MAX_MESSAGE = 4096;
const DEFAULT_COUNT = 20;
const MAX_COUNT = 1000;
const SELECTOR_LENGTH = 12;
const MAX_CALLBACK_BYTES = 64;
const LOGS_CALLBACK = /^logs:([A-Za-z0-9_-]{16}):s:([A-Za-z0-9_-]{12})$/;

interface ParsedArgs {
  name: string;
  count: number;
  since?: Date;
  invalid?: 'count' | 'duration';
}

interface LogPickerState {
  receipt: WorkflowReturnReceipt;
  targets: ReadonlyMap<string, string>;
}

/**
 * `/logs <sensor> [count]` or `/logs <sensor> --since <duration>` — spec 09.
 *
 * The picker only carries an opaque selector. Its receipt id is checked
 * against the durable workflow before any local picker data or sensor history
 * is read, so an old message cannot select a target in a newer workflow.
 */
@Injectable()
export class LogsHandler implements TelegramHandler {
  private readonly logger = new Logger(LogsHandler.name);
  private readonly pickers = new Map<string, LogPickerState>();

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(SENSOR_LOG_REPOSITORY)
    private readonly logs: SensorLogRepositoryPort,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  async handleEmpty(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt =
      launch?.receipt ??
      (await this.workflows.begin(ctx, 'logs', {
        source: 'natural-parent',
      }));
    if (!receipt) return;

    try {
      const sensors = await this.sensors.listEnabled();
      if (sensors.length === 0) {
        await this.complete(ctx, receipt, () => ctx.reply(en.status.none));
        return;
      }

      const targets = new Map<string, string>();
      const keyboard = new InlineKeyboard();
      for (const sensor of sensors) {
        const selector = selectorFor(sensor.id);
        targets.set(selector, sensor.id);
        keyboard.text(`${TYPE_ICONS[sensor.type] ?? '•'} ${sensor.name}`, callbackData(receipt.id, selector)).row();
      }
      keyboard.text((ctx.localeState?.catalog ?? en).home.common.home, workflowReturnCallback(receipt.id, 'origin'));
      this.pickers.set(pickerKey(ctx, receipt.id), { receipt, targets });
      await ctx.reply(en.logs.selectSensor, { reply_markup: keyboard });
    } catch (error) {
      this.logger.error(`/logs picker failed: ${(error as Error).message}`, (error as Error).stack);
      await this.complete(ctx, receipt, () => ctx.reply(en.logs.readFailed));
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('logs', this.guard.registered, async (ctx) => {
      const raw = (ctx.match ?? '').toString().trim();
      if (!raw) {
        await this.handleEmpty(ctx);
        return;
      }

      const receipt = await this.workflows.begin(ctx, 'logs', {
        source: 'natural-parent',
      });
      if (!receipt) return;
      const parsed = parseArgs(raw);
      if (parsed.invalid === 'count') {
        await this.complete(ctx, receipt, () => ctx.reply(en.logs.invalidCount));
        return;
      }
      if (parsed.invalid === 'duration') {
        await this.complete(ctx, receipt, () => ctx.reply(en.logs.invalidDuration));
        return;
      }

      await this.readAndDeliver(ctx, receipt, parsed.name, parsed.count, parsed.since);
    });

    composer.callbackQuery(LOGS_CALLBACK, this.guard.registered, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      const parsed = parseLogsCallback(ctx.callbackQuery?.data ?? '');
      if (!parsed) return;
      const state = this.pickers.get(pickerKey(ctx, parsed.receiptId));
      if (state?.receipt.id !== parsed.receiptId) return;
      if (!(await this.workflows.validateCurrent(ctx, state.receipt))) return;

      const sensorId = state.targets.get(parsed.selector);
      if (!sensorId) return;
      try {
        const lookup = await this.sensors.findByIdIncludingArchived(sensorId);
        if (!lookup) {
          await this.complete(ctx, state.receipt, () => ctx.reply(en.logs.notFound('selected sensor')));
          return;
        }
        this.pickers.delete(pickerKey(ctx, parsed.receiptId));
        const entries = await this.logs.findRecent(lookup.sensor.id, {
          limit: DEFAULT_COUNT,
        });
        if (entries.length === 0) {
          await this.complete(ctx, state.receipt, () => ctx.reply(en.logs.none(lookup.sensor.name)));
          return;
        }
        await this.complete(ctx, state.receipt, () => this.deliver(ctx, lookup.sensor.name, entries));
      } catch (error) {
        this.logger.error(`/logs callback failed: ${(error as Error).message}`, (error as Error).stack);
        await this.complete(ctx, state.receipt, () => ctx.reply(en.logs.readFailed));
      }
    });
  }

  private async readAndDeliver(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    name: string,
    count: number,
    since: Date | undefined,
  ): Promise<void> {
    try {
      const lookup = await this.sensors.findByName(name);
      if (!lookup) {
        await this.complete(ctx, receipt, () => ctx.reply(en.logs.notFound(name)));
        return;
      }
      const entries = await this.logs.findRecent(lookup.sensor.id, {
        limit: count,
        since,
      });
      if (entries.length === 0) {
        await this.complete(ctx, receipt, () => ctx.reply(en.logs.none(name)));
        return;
      }
      await this.complete(ctx, receipt, () => this.deliver(ctx, name, entries));
    } catch (error) {
      this.logger.error(`/logs failed: ${(error as Error).message}`, (error as Error).stack);
      await this.complete(ctx, receipt, () => ctx.reply(en.logs.readFailed));
    }
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
          failureNotice: (ctx.localeState?.catalog ?? en).home.recovery.unavailable,
        },
      );
      return;
    }
    await deliver();
  }

  private async deliver(ctx: TelegramContext, name: string, entries: SensorLogEntry[]): Promise<void> {
    const header = en.logs.header(name, entries.length);
    const body = entries.map((entry) => en.logs.line(entry)).join('\n');
    const message = `${header}\n\n${body}`;
    if (message.length <= TELEGRAM_MAX_MESSAGE) {
      await ctx.reply(message);
      return;
    }
    await ctx.replyWithDocument(new InputFile(Buffer.from(message, 'utf8'), en.logs.fileName(name)), {
      caption: header,
    });
  }
}

export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const name = tokens.shift() ?? '';
  let count = DEFAULT_COUNT;
  let since: Date | undefined;
  let invalid: ParsedArgs['invalid'];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--since' || token === '-s') {
      const ms = parseDuration(tokens[index + 1]);
      if (ms === null) {
        invalid = 'duration';
        break;
      }
      since = new Date(Date.now() - ms);
      count = MAX_COUNT;
      index += 1;
    } else if (/^\d+$/.test(token)) {
      const value = Number(token);
      if (!Number.isInteger(value) || value <= 0 || value > MAX_COUNT) {
        invalid = 'count';
        break;
      }
      count = value;
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
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000);
}

function selectorFor(sensorId: string): string {
  return createHash('sha256').update(sensorId).digest('base64url').slice(0, SELECTOR_LENGTH);
}

function callbackData(receiptId: string, selector: string): string {
  const data = `logs:${receiptId}:s:${selector}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES)
    throw new RangeError('Logs callback data exceeds Telegram limit');
  return data;
}

function parseLogsCallback(data: string): { receiptId: string; selector: string } | null {
  const match = LOGS_CALLBACK.exec(data);
  return match ? { receiptId: match[1], selector: match[2] } : null;
}

function pickerKey(ctx: TelegramContext, receiptId: string): string {
  return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
}
