import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CallbackQueryContext,
  CommandContext,
  Composer,
  InlineKeyboard,
} from 'grammy';
import { en } from '../../locales/en';
import { loadDefaults } from '../../config/config.loader';
import { AddSensorUseCase } from '../../sensors/application/add-sensor.use-case';
import { ModifySensorUseCase } from '../../sensors/application/modify-sensor.use-case';
import { RemoveSensorUseCase } from '../../sensors/application/remove-sensor.use-case';
import { DigitalConfigInvalidError } from '../../sensors/domain/errors/digital-config-invalid.error';
import { InvalidGpioPinError } from '../../sensors/domain/errors/invalid-gpio-pin.error';
import { InvalidSensorNameError } from '../../sensors/domain/errors/invalid-sensor-name.error';
import { PinAlreadyInUseError } from '../../sensors/domain/errors/pin-already-in-use.error';
import { SensorNameExistsError } from '../../sensors/domain/errors/sensor-name-exists.error';
import { SensorNotFoundError } from '../../sensors/domain/errors/sensor-not-found.error';
import { UartConfigInvalidError } from '../../sensors/domain/errors/uart-config-invalid.error';
import { Sensor, SensorSeverity, SensorType } from '../../sensors/domain/sensor';
import { DEFAULT_DIGITAL_DEBOUNCE_MS } from '../../sensors/domain/default-debounce';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { RoleMiddleware } from './role.middleware';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import {
  WorkflowDraftRegistry,
  type WorkflowDraftCanceller,
} from './workflow-draft.registry';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

type AddType = 'digital' | 'uart';
type Pull = 'up' | 'down' | 'none';

/** BCM pins exposed in the picker; ID EEPROM and I²C-reserved pins stay out. */
const SELECTABLE_GPIO_PINS = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27,
] as const;

/**
 * Per-user conversation state (spec 10). Held in-memory only; on bot
 * restart the user sees `en.common.interrupted` on their next message
 * (spec 06 § Interrupted Conversations).
 */
type ConfigState =
  | { kind: 'addType' }
  | { kind: 'addName'; type: AddType }
  | { kind: 'addDigitalPin'; name: string }
  | { kind: 'addDigitalStepType'; name: string; pin: number }
  | { kind: 'addDigitalSeverity'; name: string; pin: number; stepType: string }
  | { kind: 'addUartPort'; name: string }
  | { kind: 'addUartBaud'; name: string; port: string }
  | { kind: 'addUartWarning'; name: string; port: string; baud: number }
  | {
      kind: 'addUartCritical';
      name: string;
      port: string;
      baud: number;
      warning: number;
    }
  | { kind: 'modifyMenu'; sensorId: string; currentName: string }
  | { kind: 'modifyName'; sensorId: string; currentName: string }
  | { kind: 'modifyPin'; sensorId: string; currentName: string }
  | { kind: 'modifyDebounce'; sensorId: string; currentName: string }
  | { kind: 'modifyStepType'; sensorId: string; currentName: string }
  | { kind: 'removeConfirm'; sensorName: string }
  | { kind: 'selectModify' }
  | { kind: 'selectRemove' };

type WorkflowBoundState<T> = T & {
  userId: number;
  chatId: number;
  receiptId: string;
  receipt: WorkflowReturnReceipt;
};

type BoundConfigState = WorkflowBoundState<ConfigState>;

type ConfigSubcommand = 'add' | 'modify' | 'remove';

interface DigitalDefaults {
  debounceMs: number;
  severity: SensorSeverity;
  pull: Pull;
  activeLow: boolean;
  stepType: string;
}

interface UartDefaults {
  debounceMs: number;
  severity: SensorSeverity;
  baudRate: number;
  readIntervalMs: number;
  flushIntervalMs: number;
}

/**
 * `/config add|modify|remove` — spec 10.
 *
 * Implements a lightweight per-user FSM (admin-gated) using inline keyboards
 * and follow-up text messages. State is in-memory and intentionally lost on
 * restart (spec 06 § Interrupted Conversations).
 */
@Injectable()
export class ConfigHandler implements TelegramHandler, WorkflowDraftCanceller {
  private readonly logger = new Logger(ConfigHandler.name);
  private readonly states = new Map<string, BoundConfigState>();
  private readonly digitalDefaults: DigitalDefaults;
  private readonly uartDefaults: UartDefaults;

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly addSensor: AddSensorUseCase,
    private readonly modifySensor: ModifySensorUseCase,
    private readonly removeSensor: RemoveSensorUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly drafts: WorkflowDraftRegistry,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {
    const defaults = loadDefaults().sensor_defaults;
    this.digitalDefaults = {
      debounceMs: numberOr(defaults?.digital?.debounce_ms, DEFAULT_DIGITAL_DEBOUNCE_MS),
      severity: severityOr(defaults?.digital?.severity, 'info'),
      pull: pullOr(defaults?.digital?.pull, 'up'),
      activeLow: defaults?.digital?.active_low !== false,
      stepType: 'contact',
    };
    this.uartDefaults = {
      debounceMs: numberOr(defaults?.uart?.debounce_ms, 0),
      severity: severityOr(defaults?.uart?.severity, 'warning'),
      baudRate: numberOr(defaults?.uart?.baud_rate, 9600),
      readIntervalMs: numberOr(defaults?.uart?.read_interval_ms, 5_000),
      flushIntervalMs: numberOr(defaults?.uart?.flush_interval_ms, 60_000),
    };
    this.drafts.register('sensor-add', this);
    this.drafts.register('sensor-modify', this);
    this.drafts.register('sensor-remove', this);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('config', this.guard.adminOnly, (ctx) => this.onCommand(ctx));
    composer.command('cancel', this.guard.adminOnly, async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (state) {
        await this.complete(ctx, state, {
          effectStage: 'already-delivered',
          deliver: async () => undefined,
          failureNotice: this.catalog(ctx).home.recovery.unavailable,
        });
        return;
      }
      return next();
    });
    composer.callbackQuery(/^cfg:/, this.guard.adminOnly, (ctx) =>
      this.onCallback(ctx),
    );
    // Text fallback — only fires if this user is mid-flow.
    composer.on('message:text', this.guard.adminOnly, async (ctx, next) => {
      if (!this.stateFor(ctx)) return next();
      // Ignore commands so /cancel etc. don't pollute text inputs.
      if (ctx.message?.text?.startsWith('/')) return next();
      try {
        await this.onText(ctx, ctx.message.text.trim());
      } catch (err) {
        await this.replyError(ctx, err);
      }
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

  private workflowKeyboard(
    ctx: TelegramContext,
    state: BoundConfigState,
    keyboard = new InlineKeyboard(),
  ): InlineKeyboard {
    const catalog = this.catalog(ctx);
    const bound = bindConfigKeyboard(keyboard, state.receiptId);
    return bound.row()
      .text(catalog.config.cancelSensorSetup, workflowReturnCallback(state.receiptId, 'origin'))
      .text(catalog.home.common.home, workflowReturnCallback(state.receiptId, 'home'));
  }

  // ───────── entry point ─────────

  async handleSubcommand(
    ctx: TelegramContext,
    sub: string,
    launch?: WorkflowLaunch,
  ): Promise<void> {
    if (!isConfigSubcommand(sub)) return;
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, workflowFor(sub), {
      source: 'natural-parent',
    });
    if (!receipt) return;
    await this.presentSubcommand(ctx, sub, receipt);
  }

  private async onCommand(ctx: CommandContext<TelegramContext>): Promise<void> {
    const raw = (ctx.match ?? '').toString().trim();
    const [sub, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').trim();

    if (!isConfigSubcommand(sub)) {
      await ctx.reply(en.config.missingArg('<add|modify|remove>'));
      return;
    }
    const receipt = await this.workflows.begin(ctx, workflowFor(sub), {
      source: 'natural-parent',
    });
    if (!receipt) return;
    if (sub === 'add' || !arg) {
      await this.presentSubcommand(ctx, sub, receipt);
      return;
    }
    const sensor = await this.sensors.findByName(arg);
    if (sensor?.kind !== 'active') {
      const state = this.setInitialState(receipt, { kind: sub === 'modify' ? 'selectModify' : 'selectRemove' });
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, en.config.notFound(arg)),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    const state = this.setInitialState(receipt, sub === 'modify'
      ? { kind: 'modifyMenu', sensorId: sensor.sensor.id, currentName: sensor.sensor.name }
      : { kind: 'removeConfirm', sensorName: sensor.sensor.name });
    if (sub === 'modify') {
      await ctx.reply(
        en.config.modifyHeader({
          name: sensor.sensor.name,
          type: sensor.sensor.type,
          config: sensor.sensor.config,
          debounceMs: sensor.sensor.debounceMs,
          severity: sensor.sensor.severity,
        }),
        { reply_markup: this.workflowKeyboard(ctx, state, modifyMenu(sensor.sensor.type)) },
      );
      return;
    }
    await ctx.reply(en.config.removeConfirm(sensor.sensor.name), {
      reply_markup: this.workflowKeyboard(ctx, state, confirmKeyboard()),
    });
  }

  private async presentSubcommand(
    ctx: TelegramContext,
    sub: ConfigSubcommand,
    receipt: WorkflowReturnReceipt,
  ): Promise<void> {
    if (sub === 'add') {
      const state = this.setInitialState(receipt, { kind: 'addType' });
      await ctx.reply(en.config.step1, {
        reply_markup: this.workflowKeyboard(ctx, state, typeKeyboard()),
      });
      return;
    }
    const sensors = await this.sensors.listEnabled();
    const state = this.setInitialState(receipt, {
      kind: sub === 'modify' ? 'selectModify' : 'selectRemove',
    });
    if (sensors.length === 0) {
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, en.config.noActiveSensors),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const sensor of sensors) {
      keyboard.text(sensor.name, `cfg:${sub === 'modify' ? 'mod' : 'rem'}:${sensor.name}`).row();
    }
    await ctx.reply(sub === 'modify' ? en.config.selectModify : en.config.selectRemove, {
      reply_markup: this.workflowKeyboard(ctx, state, keyboard),
      parse_mode: 'Markdown',
    });
  }

  // ───────── callback queries ─────────

  private async onCallback(ctx: CallbackQueryContext<TelegramContext>): Promise<void> {
    const parsed = parseConfigCallback(ctx.callbackQuery.data ?? '');
    await ctx.answerCallbackQuery().catch(() => undefined);
    const state = this.stateFor(ctx);
    if (parsed?.receiptId !== state?.receiptId) return;
    if (!parsed || !state) return;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    try {
      await this.routeCallback(ctx, state, parsed.action);
    } catch (err) {
      await this.replyError(ctx, err);
    }
  }

  private async routeCallback(
    ctx: TelegramContext,
    state: BoundConfigState,
    action: string,
  ): Promise<void> {
    if (action.startsWith('back:')) {
      await this.handleBack(ctx, state, action.slice('back:'.length));
      return;
    }
    if (action.startsWith('mod:')) {
      const name = action.slice('mod:'.length).trim();
      const sensor = await this.sensors.findByName(name);
      if (sensor?.kind !== 'active') {
        await ctx.reply(en.config.notFound(name), {
          reply_markup: this.workflowKeyboard(ctx, state),
        });
        return;
      }
      const next = this.setState(state, {
        kind: 'modifyMenu',
        sensorId: sensor.sensor.id,
        currentName: sensor.sensor.name,
      });
      await ctx.reply(
        en.config.modifyHeader({
          name: sensor.sensor.name,
          type: sensor.sensor.type,
          config: sensor.sensor.config,
          debounceMs: sensor.sensor.debounceMs,
          severity: sensor.sensor.severity,
        }),
        { reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(sensor.sensor.type)) },
      );
      return;
    }
    if (action.startsWith('rem:')) {
      const name = action.slice('rem:'.length).trim();
      const sensor = await this.sensors.findByName(name);
      if (sensor?.kind !== 'active') {
        await ctx.reply(en.config.notFound(name), {
          reply_markup: this.workflowKeyboard(ctx, state),
        });
        return;
      }
      const next = this.setState(state, { kind: 'removeConfirm', sensorName: sensor.sensor.name });
      await ctx.reply(en.config.removeConfirm(sensor.sensor.name), {
        reply_markup: this.workflowKeyboard(ctx, next, confirmKeyboard()),
      });
      return;
    }
    if (state.kind === 'addType' && action.startsWith('type:')) {
      const type = action.slice('type:'.length) as AddType;
      if (type !== 'digital' && type !== 'uart') return;
      const next = this.setState(state, { kind: 'addName', type });
      await ctx.reply(en.config.step2(type), {
        reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('addType')),
      });
      return;
    }
    if (state.kind === 'addDigitalPin' && action.startsWith('pin:')) {
      const pin = parseIntStrict(action.slice('pin:'.length));
      if (pin === null || !isSelectableGpioPin(pin)) return;
      const owner = await this.findPinOwner(pin);
      if (owner) {
        await ctx.reply(en.config.pinTaken(pin, owner), {
          reply_markup: this.workflowKeyboard(ctx, state),
        });
        await this.showDigitalPinPicker(ctx, state.name);
        return;
      }
      const next = this.setState(state, { kind: 'addDigitalStepType', name: state.name, pin });
      await ctx.reply(en.config.step4Digital(state.name, pin), {
        reply_markup: this.workflowKeyboard(ctx, next, stepTypeKeyboard('addDigitalPin')),
      });
      return;
    }
    if (state.kind === 'addDigitalStepType' && action === 'default:digital') {
      const created = await this.addSensor.execute({
        name: state.name,
        type: 'digital',
        config: {
          pin: state.pin,
          stepType: 'contact',
          invert: this.digitalDefaults.activeLow,
          activeLow: this.digitalDefaults.activeLow,
          pull: this.digitalDefaults.pull,
        },
        debounceMs: this.digitalDefaults.debounceMs,
        severity: this.digitalDefaults.severity,
      });
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, en.config.addedDigital(
          created.name,
          state.pin,
          'contact',
          this.digitalDefaults.severity,
        )),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    if (state.kind === 'addDigitalStepType' && action.startsWith('st:')) {
      const stepType = action.slice('st:'.length);
      const next = this.setState(state, {
        kind: 'addDigitalSeverity',
        name: state.name,
        pin: state.pin,
        stepType,
      });
      await ctx.reply(en.config.step5Digital(state.name, state.pin, stepType), {
        reply_markup: this.workflowKeyboard(ctx, next, severityKeyboard()),
      });
      return;
    }
    if (state.kind === 'addDigitalSeverity' && action.startsWith('sev:')) {
      const severity = action.slice('sev:'.length) as SensorSeverity;
      if (!isSeverity(severity)) return;
      const created = await this.addSensor.execute({
        name: state.name,
        type: 'digital',
        config: {
          pin: state.pin,
          stepType: state.stepType,
          invert: this.digitalDefaults.activeLow,
          activeLow: this.digitalDefaults.activeLow,
          pull: this.digitalDefaults.pull,
        },
        debounceMs: this.digitalDefaults.debounceMs,
        severity,
      });
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, en.config.addedDigital(
          created.name,
          state.pin,
          state.stepType,
          severity,
        )),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    if (state.kind === 'addUartBaud' && action.startsWith('baud:')) {
      const baud = Number(action.slice('baud:'.length));
      if (!Number.isFinite(baud) || baud <= 0) return;
      const next = this.setState(state, {
        kind: 'addUartWarning',
        name: state.name,
        port: state.port,
        baud,
      });
      await ctx.reply(en.config.step5Uart(state.name, state.port, baud), {
        reply_markup: this.workflowKeyboard(ctx, next),
      });
      return;
    }
    if (state.kind === 'modifyMenu' && action.startsWith('modify:')) {
      await this.modifyFieldPrompt(ctx, state, action.slice('modify:'.length));
      return;
    }
    if (state.kind === 'modifyStepType' && action.startsWith('st:')) {
      const stepType = action.slice('st:'.length);
      const current = await this.sensors.findById(state.sensorId);
      if (!current) throw new SensorNotFoundError(state.currentName);
      const nextConfig = { ...current.config, stepType };
      await this.modifySensor.execute({
        currentName: state.currentName,
        patch: { config: nextConfig },
      });
      const next = this.setState(state, {
        kind: 'modifyMenu',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.modifiedField('Step Type'), {
        reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(current.type)),
      });
      return;
    }
    if (action.startsWith('msev:') && isModifyState(state)) {
      const severity = action.slice('msev:'.length) as SensorSeverity;
      if (!isSeverity(severity)) return;
      await this.modifySensor.execute({
        currentName: state.currentName,
        patch: { severity },
      });
      const next = this.setState(state, {
        kind: 'modifyMenu',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.modifiedField('Severity'), {
        reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(await this.lookupType(state.sensorId))),
      });
      return;
    }
    if (state.kind === 'removeConfirm' && action === 'rm:confirm') {
      await this.removeSensor.execute(state.sensorName);
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, en.config.removed(state.sensorName)),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
  }

  // ───────── text inputs ─────────

  private async onText(ctx: TelegramContext, text: string): Promise<void> {
    const state = this.stateFor(ctx);
    if (!state) return;

    switch (state.kind) {
      case 'addName': {
        if (state.type === 'digital') {
          this.setState(state, { kind: 'addDigitalPin', name: text });
          await this.showDigitalPinPicker(ctx, text);
        } else {
          const next = this.setState(state, { kind: 'addUartPort', name: text });
          await ctx.reply(en.config.step3Uart(text), {
            reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('addName')),
          });
        }
        return;
      }
      case 'addDigitalPin': {
        await ctx.reply(en.config.gpioPickerOnly, {
          reply_markup: this.workflowKeyboard(ctx, state),
        });
        return;
      }
      case 'addUartPort': {
        if (!text) {
          await ctx.reply(en.config.invalidPortPath, {
            reply_markup: this.workflowKeyboard(ctx, state),
          });
          return;
        }
        const next = this.setState(state, { kind: 'addUartBaud', name: state.name, port: text });
        await ctx.reply(en.config.step4Uart(state.name, text), {
          reply_markup: this.workflowKeyboard(ctx, next, baudKeyboard()),
        });
        return;
      }
      case 'addUartWarning': {
        const warning = parseIntStrict(text);
        if (warning === null || warning <= 0) {
          await ctx.reply(en.config.invalidNumber, {
            reply_markup: this.workflowKeyboard(ctx, state),
          });
          return;
        }
        const next = this.setState(state, {
          kind: 'addUartCritical',
          name: state.name,
          port: state.port,
          baud: state.baud,
          warning,
        });
        await ctx.reply(en.config.criticalQuestion, {
          reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('addUartWarning')),
        });
        return;
      }
      case 'addUartCritical': {
        const critical = parseIntStrict(text);
        if (critical === null || critical <= 0) {
          await ctx.reply(en.config.invalidNumber, {
            reply_markup: this.workflowKeyboard(ctx, state),
          });
          return;
        }
        if (critical <= state.warning) {
          await ctx.reply(en.config.invalidThresholdOrder(state.warning), {
            reply_markup: this.workflowKeyboard(ctx, state),
          });
          return;
        }
        await this.addSensor.execute({
          name: state.name,
          type: 'uart',
          config: {
            port: state.port,
            baudRate: state.baud,
            thresholds: { warning: state.warning, critical },
            readIntervalMs: this.uartDefaults.readIntervalMs,
            flushIntervalMs: this.uartDefaults.flushIntervalMs,
          },
          debounceMs: this.uartDefaults.debounceMs,
          severity: this.uartDefaults.severity,
        });
        await this.complete(ctx, state, {
          effectStage: 'pending',
          deliver: () => this.reply(ctx, en.config.addedUart(state.name, state.port, state.baud, state.warning, critical)),
          failureNotice: this.catalog(ctx).home.recovery.unavailable,
        });
        return;
      }
      case 'modifyName': {
        await this.modifySensor.execute({
          currentName: state.currentName,
          patch: { name: text },
        });
        const next = this.setState(state, {
          kind: 'modifyMenu',
          sensorId: state.sensorId,
          currentName: text,
        });
        await ctx.reply(en.config.modifiedField('Name'), {
          reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(await this.lookupType(state.sensorId))),
        });
        return;
      }
      case 'modifyPin': {
        const pin = parseIntStrict(text);
        if (pin === null || pin < 0 || pin > 27) {
          await ctx.reply(en.config.invalidPinRange, {
            reply_markup: this.workflowKeyboard(ctx, state),
          });
          return;
        }
        const current = await this.sensors.findById(state.sensorId);
        if (!current) throw new SensorNotFoundError(state.currentName);
        const nextConfig = { ...current.config, pin };
        await this.modifySensor.execute({
          currentName: state.currentName,
          patch: { config: nextConfig },
        });
        const next = this.setState(state, {
          kind: 'modifyMenu',
          sensorId: state.sensorId,
          currentName: state.currentName,
        });
        await ctx.reply(en.config.modifiedField('Pin'), {
          reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(current.type)),
        });
        return;
      }
      case 'modifyDebounce': {
        const ms = parseIntStrict(text);
        if (ms === null || ms < 0) {
          await ctx.reply(en.config.invalidDebounce, {
            reply_markup: this.workflowKeyboard(ctx, state),
          });
          return;
        }
        await this.modifySensor.execute({
          currentName: state.currentName,
          patch: { debounceMs: ms },
        });
        const next = this.setState(state, {
          kind: 'modifyMenu',
          sensorId: state.sensorId,
          currentName: state.currentName,
        });
        await ctx.reply(en.config.modifiedField('Debounce'), {
          reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(await this.lookupType(state.sensorId))),
        });
        return;
      }
    }
  }

  // ───────── modify helpers ─────────

  private async modifyFieldPrompt(
    ctx: TelegramContext,
    state: Extract<BoundConfigState, { kind: 'modifyMenu' }>,
    field: string,
  ): Promise<void> {
    if (field === 'done') {
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, en.config.modifyDone(state.currentName)),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    if (field === 'name') {
      const next = this.setState(state, {
        kind: 'modifyName',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.nameQuestion, {
        reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('modifyMenu')),
      });
      return;
    }
    if (field === 'pin') {
      const next = this.setState(state, {
        kind: 'modifyPin',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      const used = await this.getUsedPinsText();
      await ctx.reply(en.config.pinQuestion(used), {
        reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('modifyMenu')),
        parse_mode: 'HTML',
      });
      return;
    }
    if (field === 'invert') {
      const current = await this.sensors.findById(state.sensorId);
      if (!current) throw new SensorNotFoundError(state.currentName);
      const oldInvert = current.config.invert ?? current.config.activeLow ?? true;
      const newInvert = !oldInvert;
      const nextConfig = { ...current.config, invert: newInvert, activeLow: newInvert };
      await this.modifySensor.execute({
        currentName: state.currentName,
        patch: { config: nextConfig },
      });
      const stateStr = newInvert ? 'Inverted (Active Low)' : 'Direct (Active High)';
      await ctx.reply(en.config.invertToggleSuccess(state.currentName, stateStr), {
        reply_markup: this.workflowKeyboard(ctx, state, modifyMenu(current.type)),
      });
      return;
    }
    if (field === 'steptype') {
      const next = this.setState(state, {
        kind: 'modifyStepType',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.stepTypeQuestion, {
        reply_markup: this.workflowKeyboard(ctx, next, stepTypeKeyboard('modifyMenu')),
      });
      return;
    }
    if (field === 'debounce') {
      const next = this.setState(state, {
        kind: 'modifyDebounce',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.debouncePrompt, {
        reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('modifyMenu')),
      });
      return;
    }
    if (field === 'severity') {
      // Stay in modifyMenu state shape — severity callback short-circuits.
      await ctx.reply(en.config.severityQuestion, {
        reply_markup: this.workflowKeyboard(ctx, state, modifySeverityKeyboard()),
      });
      return;
    }
  }

  private async getUsedPinsText(): Promise<string> {
    const sensors = await this.sensors.listEnabled();
    const used: string[] = [];
    for (const s of sensors) {
      if (s.type === 'digital' && typeof s.config.pin === 'number') {
        used.push(`Pin ${s.config.pin} (${s.name})`);
      }
    }
    return used.length > 0 ? used.join(', ') : 'none';
  }

  private async findPinOwner(pin: number): Promise<string | null> {
    const sensors = await this.sensors.listEnabled();
    const owner = sensors.find(
      (sensor) => sensor.type === 'digital' && sensor.config.pin === pin,
    );
    return owner?.name ?? null;
  }

  private async showDigitalPinPicker(ctx: TelegramContext, name: string): Promise<void> {
    const state = this.stateFor(ctx);
    if (!state) return;
    const sensors = await this.sensors.listEnabled();
    const usedPins = new Set(
      sensors
        .filter((sensor) => sensor.type === 'digital' && typeof sensor.config.pin === 'number')
        .map((sensor) => sensor.config.pin as number),
    );
    const availablePins = SELECTABLE_GPIO_PINS.filter((pin) => !usedPins.has(pin));
    const usedText = await this.getUsedPinsText();
    await ctx.reply(
      availablePins.length > 0
        ? en.config.step3Digital(name, usedText)
        : en.config.noAvailableGpioPins,
      {
        reply_markup: this.workflowKeyboard(ctx, state, digitalPinKeyboard(availablePins)),
        parse_mode: 'HTML',
      },
    );
  }

  private async handleBack(
    ctx: TelegramContext,
    state: BoundConfigState,
    target: string,
  ): Promise<void> {
    switch (target) {
      case 'addType': {
        const next = this.setState(state, { kind: 'addType' });
        await ctx.reply(en.config.step1, {
          reply_markup: this.workflowKeyboard(ctx, next, typeKeyboard()),
        });
        break;
      }
      case 'addName': {
        const type =
          state.kind === 'addDigitalPin' ||
          state.kind === 'addDigitalStepType' ||
          state.kind === 'addDigitalSeverity'
            ? 'digital'
            : 'uart';
        const next = this.setState(state, { kind: 'addName', type });
        await ctx.reply(en.config.step2(type), {
          reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('addType')),
        });
        break;
      }
      case 'addDigitalPin': {
        if ('name' in state) {
          this.setState(state, { kind: 'addDigitalPin', name: state.name });
          await this.showDigitalPinPicker(ctx, state.name);
        }
        break;
      }
      case 'addDigitalStepType': {
        if ('name' in state && 'pin' in state) {
          const next = this.setState(state, {
            kind: 'addDigitalStepType',
            name: state.name,
            pin: state.pin,
          });
          await ctx.reply(en.config.step4Digital(state.name, state.pin), {
            reply_markup: this.workflowKeyboard(ctx, next, stepTypeKeyboard('addDigitalPin')),
          });
        }
        break;
      }
      case 'addUartPort': {
        if ('name' in state) {
          const next = this.setState(state, { kind: 'addUartPort', name: state.name });
          await ctx.reply(en.config.step3Uart(state.name), {
            reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('addName')),
          });
        }
        break;
      }
      case 'addUartBaud': {
        if ('name' in state && 'port' in state) {
          const next = this.setState(state, {
            kind: 'addUartBaud',
            name: state.name,
            port: state.port,
          });
          await ctx.reply(en.config.step4Uart(state.name, state.port), {
            reply_markup: this.workflowKeyboard(ctx, next, baudKeyboard()),
          });
        }
        break;
      }
      case 'addUartWarning': {
        if ('name' in state && 'port' in state && 'baud' in state) {
          const next = this.setState(state, {
            kind: 'addUartWarning',
            name: state.name,
            port: state.port,
            baud: state.baud,
          });
          await ctx.reply(en.config.step5Uart(state.name, state.port, state.baud), {
            reply_markup: this.workflowKeyboard(ctx, next, backCancelKeyboard('addUartBaud')),
          });
        }
        break;
      }
      case 'modifyMenu': {
        if (isModifyState(state)) {
          const next = this.setState(state, {
            kind: 'modifyMenu',
            sensorId: state.sensorId,
            currentName: state.currentName,
          });
          const sensor = await this.sensors.findById(state.sensorId);
          if (sensor) {
            await ctx.reply(
              en.config.modifyHeader({
                name: sensor.name,
                type: sensor.type,
                config: sensor.config,
                debounceMs: sensor.debounceMs,
                severity: sensor.severity,
              }),
              { reply_markup: this.workflowKeyboard(ctx, next, modifyMenu(sensor.type)) },
            );
          }
        }
        break;
      }
    }
  }

  private async lookupType(sensorId: string): Promise<SensorType> {
    const sensor = await this.sensors.findById(sensorId);
    return sensor?.type ?? 'digital';
  }

  private setInitialState<T extends ConfigState>(
    receipt: WorkflowReturnReceipt,
    next: T,
  ): WorkflowBoundState<T> {
    const state = {
      ...next,
      userId: receipt.userId,
      chatId: receipt.chatId,
      receiptId: receipt.id,
      receipt,
    } as WorkflowBoundState<T>;
    this.states.set(stateKey(state.userId, state.chatId), state);
    return state;
  }

  private setState<T extends ConfigState>(
    state: BoundConfigState,
    next: T,
  ): WorkflowBoundState<T> {
    return this.setInitialState(state.receipt, next);
  }

  private stateFor(ctx: TelegramContext): BoundConfigState | null {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) return null;
    const chatId = ctx.chat?.type === 'private' ? ctx.chat.id : userId;
    return this.states.get(stateKey(userId, chatId)) ?? null;
  }

  private catalog(ctx: TelegramContext) {
    return ctx.localeState?.catalog ?? en;
  }

  private async reply(ctx: TelegramContext, text: string): Promise<void> {
    await ctx.reply(text);
  }

  private async complete(
    ctx: TelegramContext,
    state: BoundConfigState,
    presentation: {
      effectStage: 'pending' | 'already-delivered';
      deliver(): Promise<void>;
      failureNotice: string;
    },
  ): Promise<void> {
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt: state.receipt }, presentation);
      return;
    }
    if (presentation.effectStage === 'pending') await presentation.deliver();
    await this.cancelExact({
      userId: state.userId,
      chatId: state.chatId,
      receiptId: state.receiptId,
    });
  }

  // ───────── errors ─────────

  private async replyError(ctx: TelegramContext, err: unknown): Promise<void> {
    const state = this.stateFor(ctx);
    const options = state ? { reply_markup: this.workflowKeyboard(ctx, state) } : undefined;
    if (err instanceof SensorNameExistsError) {
      await ctx.reply(en.config.nameTaken(err.sensorName), options);
      return;
    }
    if (err instanceof SensorNotFoundError) {
      await ctx.reply(en.config.notFound(err.sensorName), options);
      return;
    }
    if (err instanceof PinAlreadyInUseError) {
      await ctx.reply(en.config.pinTaken(err.pin, err.owner), options);
      return;
    }
    if (err instanceof InvalidGpioPinError) {
      await ctx.reply(en.config.invalidPin, options);
      return;
    }
    if (err instanceof InvalidSensorNameError) {
      await ctx.reply(en.config.invalidName, options);
      return;
    }
    if (err instanceof DigitalConfigInvalidError) {
      await ctx.reply(`❌ ${err.message}`, options);
      return;
    }
    if (err instanceof UartConfigInvalidError) {
      await ctx.reply(`❌ ${err.message}`, options);
      return;
    }
    this.logger.error(`/config failed: ${(err as Error).message}`, (err as Error).stack);
    const message = en.common.error('process /config', 'internal error');
    if (state) {
      await this.complete(ctx, state, {
        effectStage: 'pending',
        deliver: () => this.reply(ctx, message),
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    await ctx.reply(message, options);
  }
}

// ───────── keyboards ─────────

function typeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Digital', 'cfg:type:digital')
    .text('UART', 'cfg:type:uart');
}

function backCancelKeyboard(backTarget: string): InlineKeyboard {
  return new InlineKeyboard().text(en.common.backButton, `cfg:back:${backTarget}`);
}

function digitalPinKeyboard(pins: readonly number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  pins.forEach((pin, index) => {
    kb.text(`GPIO ${pin}`, `cfg:pin:${pin}`);
    if ((index + 1) % 3 === 0) kb.row();
  });
  if (pins.length % 3 !== 0) kb.row();
  return kb.text(en.common.backButton, 'cfg:back:addName');
}

function stepTypeKeyboard(backTarget: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🚪 Contact', 'cfg:st:contact')
    .text('💧 Leak', 'cfg:st:leak_hazard')
    .text('🚨 Alarm', 'cfg:st:alarm')
    .row()
    .text('⚡ Power', 'cfg:st:power')
    .text('🏃 Motion', 'cfg:st:motion')
    .text('🔘 Button', 'cfg:st:button')
    .row();
  if (backTarget !== 'modifyMenu') {
    kb.text(en.config.defaultButton, 'cfg:default:digital').row();
  }
  kb.text(en.common.backButton, `cfg:back:${backTarget}`);
  return kb;
}

function severityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Info', 'cfg:sev:info')
    .text('Warning', 'cfg:sev:warning')
    .text('Critical', 'cfg:sev:critical')
    .row()
    .text(en.common.backButton, 'cfg:back:addDigitalStepType');
}

function modifySeverityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Info', 'cfg:msev:info')
    .text('Warning', 'cfg:msev:warning')
    .text('Critical', 'cfg:msev:critical')
    .row()
    .text(en.common.backButton, 'cfg:back:modifyMenu');
}

function baudKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('9600', 'cfg:baud:9600')
    .text('115200', 'cfg:baud:115200')
    .row()
    .text(en.common.backButton, 'cfg:back:addUartPort');
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('Confirm', 'cfg:rm:confirm');
}

function modifyMenu(type: SensorType): InlineKeyboard {
  const kb = new InlineKeyboard().text('Name', 'cfg:modify:name');
  if (type === 'digital') {
    kb.text('Pin', 'cfg:modify:pin').row();
    kb.text('Invert State', 'cfg:modify:invert').text('Step Type', 'cfg:modify:steptype').row();
  } else {
    kb.row();
  }
  kb.text('Debounce', 'cfg:modify:debounce').text('Severity', 'cfg:modify:severity').row();
  kb.text('Done', 'cfg:modify:done').row();
  return kb;
}

// ───────── helpers ─────────

const CONFIG_CALLBACK = /^cfg:([A-Za-z0-9_-]{16}):(.+)$/;

function stateKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function workflowFor(sub: ConfigSubcommand): 'sensor-add' | 'sensor-modify' | 'sensor-remove' {
  switch (sub) {
    case 'add': return 'sensor-add';
    case 'modify': return 'sensor-modify';
    case 'remove': return 'sensor-remove';
  }
}

function isConfigSubcommand(value: string): value is ConfigSubcommand {
  return value === 'add' || value === 'modify' || value === 'remove';
}

function parseConfigCallback(data: string): { receiptId: string; action: string } | null {
  const match = CONFIG_CALLBACK.exec(data);
  if (!match) return null;
  return { receiptId: match[1], action: match[2] };
}

function bindConfigKeyboard(keyboard: InlineKeyboard, receiptId: string): InlineKeyboard {
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      if ('callback_data' in button && typeof button.callback_data === 'string'
        && button.callback_data.startsWith('cfg:')) {
        button.callback_data = `cfg:${receiptId}:${button.callback_data.slice('cfg:'.length)}`;
      }
    }
  }
  return keyboard;
}

function parseIntStrict(input: string): number | null {
  if (!/^-?\d+$/.test(input)) return null;
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

function isSelectableGpioPin(pin: number): pin is (typeof SELECTABLE_GPIO_PINS)[number] {
  return SELECTABLE_GPIO_PINS.includes(pin as (typeof SELECTABLE_GPIO_PINS)[number]);
}

function isSeverity(value: string): value is SensorSeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function isModifyState(
  state: BoundConfigState,
): state is Extract<BoundConfigState, { kind: 'modifyMenu' | 'modifyName' | 'modifyPin' | 'modifyDebounce' | 'modifyStepType' }> {
  return (
    state.kind === 'modifyMenu' ||
    state.kind === 'modifyName' ||
    state.kind === 'modifyPin' ||
    state.kind === 'modifyDebounce' ||
    state.kind === 'modifyStepType'
  );
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function severityOr(raw: unknown, fallback: SensorSeverity): SensorSeverity {
  return raw === 'info' || raw === 'warning' || raw === 'critical' ? raw : fallback;
}

function pullOr(raw: unknown, fallback: Pull): Pull {
  return raw === 'up' || raw === 'down' || raw === 'none' ? raw : fallback;
}

// Sensor & SensorType imports kept for type narrowing in the error reply path.
// Re-export used types for downstream typing convenience.
export type { Sensor };
