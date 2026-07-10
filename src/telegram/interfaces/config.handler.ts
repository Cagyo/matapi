import { Injectable, Logger } from '@nestjs/common';
import {
  CallbackQueryContext,
  CommandContext,
  Composer,
  Context,
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
import { Inject } from '@nestjs/common';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

type AddType = 'digital' | 'uart';
type Pull = 'up' | 'down' | 'none';

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
export class ConfigHandler implements TelegramHandler {
  private readonly logger = new Logger(ConfigHandler.name);
  private readonly states = new Map<number, ConfigState>();
  private readonly digitalDefaults: DigitalDefaults;
  private readonly uartDefaults: UartDefaults;

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly addSensor: AddSensorUseCase,
    private readonly modifySensor: ModifySensorUseCase,
    private readonly removeSensor: RemoveSensorUseCase,
    private readonly guard: RoleMiddleware,
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
  }

  register(composer: Composer<Context>): void {
    composer.command('config', this.guard.adminOnly, (ctx) => this.onCommand(ctx));
    composer.command('cancel', this.guard.adminOnly, async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId && this.states.has(userId)) {
        this.states.delete(userId);
        await ctx.reply(en.config.cancelled);
        return;
      }
      return next();
    });
    composer.callbackQuery(/^cfg:/, this.guard.adminOnly, (ctx) =>
      this.onCallback(ctx),
    );
    // Text fallback — only fires if this user is mid-flow.
    composer.on('message:text', this.guard.adminOnly, async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.states.has(userId)) return next();
      // Ignore commands so /cancel etc. don't pollute text inputs.
      if (ctx.message?.text?.startsWith('/')) return next();
      try {
        await this.onText(ctx, ctx.message.text.trim());
      } catch (err) {
        await this.replyError(ctx, err);
      }
    });
  }

  // ───────── entry point ─────────

  async handleSubcommand(ctx: Context, sub: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (sub === 'add') {
      this.states.set(userId, { kind: 'addType' });
      await ctx.reply(en.config.step1, { reply_markup: typeKeyboard() });
      return;
    }
    if (sub === 'modify') {
      const sensors = await this.sensors.listEnabled();
      if (sensors.length === 0) {
        await ctx.reply(en.config.noActiveSensors);
        return;
      }
      this.states.set(userId, { kind: 'selectModify' });
      const kb = new InlineKeyboard();
      for (const s of sensors) {
        kb.text(s.name, `cfg:mod:${s.name}`).row();
      }
      kb.text(en.common.cancelButton, 'cfg:cancel');
      await ctx.reply(en.config.selectModify, { reply_markup: kb, parse_mode: 'Markdown' });
      return;
    }
    if (sub === 'remove') {
      const sensors = await this.sensors.listEnabled();
      if (sensors.length === 0) {
        await ctx.reply(en.config.noActiveSensors);
        return;
      }
      this.states.set(userId, { kind: 'selectRemove' });
      const kb = new InlineKeyboard();
      for (const s of sensors) {
        kb.text(s.name, `cfg:rem:${s.name}`).row();
      }
      kb.text(en.common.cancelButton, 'cfg:cancel');
      await ctx.reply(en.config.selectRemove, { reply_markup: kb, parse_mode: 'Markdown' });
      return;
    }
  }

  private async onCommand(ctx: CommandContext<Context>): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const raw = (ctx.match ?? '').toString().trim();
    const [sub, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').trim();

    if (sub === 'add') {
      this.states.set(userId, { kind: 'addType' });
      await ctx.reply(en.config.step1, { reply_markup: typeKeyboard() });
      return;
    }
    if (sub === 'modify') {
      if (!arg) {
        await this.handleSubcommand(ctx, 'modify');
        return;
      }
      const sensor = await this.sensors.findByName(arg);
      if (sensor?.kind !== 'active') {
        await ctx.reply(en.config.notFound(arg));
        return;
      }
      this.states.set(userId, {
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
        { reply_markup: modifyMenu(sensor.sensor.type) },
      );
      return;
    }
    if (sub === 'remove') {
      if (!arg) {
        await this.handleSubcommand(ctx, 'remove');
        return;
      }
      const sensor = await this.sensors.findByName(arg);
      if (sensor?.kind !== 'active') {
        await ctx.reply(en.config.notFound(arg));
        return;
      }
      this.states.set(userId, { kind: 'removeConfirm', sensorName: sensor.sensor.name });
      await ctx.reply(en.config.removeConfirm(sensor.sensor.name), {
        reply_markup: confirmKeyboard(),
      });
      return;
    }
    await ctx.reply(en.config.missingArg('<add|modify|remove>'));
  }

  // ───────── callback queries ─────────

  private async onCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    const data = ctx.callbackQuery.data ?? '';
    const state = this.states.get(userId);
    // Always ack so the spinner stops, even if we ignore.
    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    if (!state) {
      await ctx.reply(en.common.interrupted);
      return;
    }
    try {
      await this.routeCallback(ctx, userId, state, data);
    } catch (err) {
      await this.replyError(ctx, err);
    }
  }

  private async routeCallback(
    ctx: Context,
    userId: number,
    state: ConfigState,
    data: string,
  ): Promise<void> {
    if (data === 'cfg:cancel') {
      this.states.delete(userId);
      await ctx.reply(en.config.cancelled);
      return;
    }
    if (data.startsWith('cfg:back:')) {
      const backTarget = data.slice('cfg:back:'.length);
      await this.handleBack(ctx, userId, state, backTarget);
      return;
    }
    if (data.startsWith('cfg:mod:')) {
      const name = data.slice('cfg:mod:'.length).trim();
      const sensor = await this.sensors.findByName(name);
      if (sensor?.kind !== 'active') {
        await ctx.reply(en.config.notFound(name));
        return;
      }
      this.states.set(userId, {
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
        { reply_markup: modifyMenu(sensor.sensor.type) },
      );
      return;
    }
    if (data.startsWith('cfg:rem:')) {
      const name = data.slice('cfg:rem:'.length).trim();
      const sensor = await this.sensors.findByName(name);
      if (sensor?.kind !== 'active') {
        await ctx.reply(en.config.notFound(name));
        return;
      }
      this.states.set(userId, { kind: 'removeConfirm', sensorName: sensor.sensor.name });
      await ctx.reply(en.config.removeConfirm(sensor.sensor.name), {
        reply_markup: confirmKeyboard(),
      });
      return;
    }
    // cfg:type:<digital|uart>
    if (state.kind === 'addType' && data.startsWith('cfg:type:')) {
      const type = data.slice('cfg:type:'.length) as AddType;
      if (type !== 'digital' && type !== 'uart') return;
      this.states.set(userId, { kind: 'addName', type });
      await ctx.reply(en.config.step2(type), { reply_markup: backCancelKeyboard('addType') });
      return;
    }
    // cfg:default:digital
    if (state.kind === 'addDigitalStepType' && data === 'cfg:default:digital') {
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
      this.states.delete(userId);
      await ctx.reply(
        en.config.addedDigital(
          created.name,
          state.pin,
          'contact',
          this.digitalDefaults.severity,
        ),
      );
      return;
    }
    // cfg:st:<stepType> during add
    if (state.kind === 'addDigitalStepType' && data.startsWith('cfg:st:')) {
      const stepType = data.slice('cfg:st:'.length);
      this.states.set(userId, {
        kind: 'addDigitalSeverity',
        name: state.name,
        pin: state.pin,
        stepType,
      });
      await ctx.reply(en.config.step5Digital(state.name, state.pin, stepType), {
        reply_markup: severityKeyboard(),
      });
      return;
    }
    // cfg:sev:<info|warning|critical>
    if (state.kind === 'addDigitalSeverity' && data.startsWith('cfg:sev:')) {
      const severity = data.slice('cfg:sev:'.length) as SensorSeverity;
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
      this.states.delete(userId);
      await ctx.reply(
        en.config.addedDigital(
          created.name,
          state.pin,
          state.stepType,
          severity,
        ),
      );
      return;
    }
    // cfg:baud:<9600|115200>
    if (state.kind === 'addUartBaud' && data.startsWith('cfg:baud:')) {
      const baud = Number(data.slice('cfg:baud:'.length));
      if (!Number.isFinite(baud) || baud <= 0) return;
      this.states.set(userId, {
        kind: 'addUartWarning',
        name: state.name,
        port: state.port,
        baud,
      });
      await ctx.reply(en.config.step5Uart(state.name, state.port, baud));
      return;
    }
    // cfg:modify:<field|done>
    if (state.kind === 'modifyMenu' && data.startsWith('cfg:modify:')) {
      const field = data.slice('cfg:modify:'.length);
      await this.modifyFieldPrompt(ctx, userId, state, field);
      return;
    }
    // cfg:st:<stepType> during modify
    if (state.kind === 'modifyStepType' && data.startsWith('cfg:st:')) {
      const stepType = data.slice('cfg:st:'.length);
      const current = await this.sensors.findById(state.sensorId);
      if (!current) throw new SensorNotFoundError(state.currentName);
      const nextConfig = { ...current.config, stepType };
      await this.modifySensor.execute({
        currentName: state.currentName,
        patch: { config: nextConfig },
      });
      this.states.set(userId, {
        kind: 'modifyMenu',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.modifiedField('Step Type'), {
        reply_markup: modifyMenu(current.type),
      });
      return;
    }
    // cfg:msev:<severity>  — modify a sensor's severity in one step
    if (data.startsWith('cfg:msev:') && isModifyState(state)) {
      const severity = data.slice('cfg:msev:'.length) as SensorSeverity;
      if (!isSeverity(severity)) return;
      await this.modifySensor.execute({
        currentName: state.currentName,
        patch: { severity },
      });
      this.states.set(userId, {
        kind: 'modifyMenu',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.modifiedField('Severity'), {
        reply_markup: modifyMenu(await this.lookupType(state.sensorId)),
      });
      return;
    }
    // cfg:rm:<confirm|cancel>
    if (state.kind === 'removeConfirm' && data.startsWith('cfg:rm:')) {
      if (data === 'cfg:rm:confirm') {
        await this.removeSensor.execute(state.sensorName);
        this.states.delete(userId);
        await ctx.reply(en.config.removed(state.sensorName));
      } else {
        this.states.delete(userId);
        await ctx.reply(en.config.cancelled);
      }
      return;
    }
  }

  // ───────── text inputs ─────────

  private async onText(ctx: Context, text: string): Promise<void> {
    const userId = ctx.from!.id;
    const state = this.states.get(userId)!;

    switch (state.kind) {
      case 'addName': {
        if (state.type === 'digital') {
          this.states.set(userId, { kind: 'addDigitalPin', name: text });
          await ctx.reply(en.config.step3Digital(text, await this.getUsedPinsText()), {
            reply_markup: backCancelKeyboard('addName'),
            parse_mode: 'HTML',
          });
        } else {
          this.states.set(userId, { kind: 'addUartPort', name: text });
          await ctx.reply(en.config.step3Uart(text), {
            reply_markup: backCancelKeyboard('addName'),
          });
        }
        return;
      }
      case 'addDigitalPin': {
        const pin = parseIntStrict(text);
        if (pin === null || pin < 0 || pin > 27)
          return void ctx.reply(en.config.invalidPinRange);
        this.states.set(userId, { kind: 'addDigitalStepType', name: state.name, pin });
        await ctx.reply(en.config.step4Digital(state.name, pin), { reply_markup: stepTypeKeyboard('addDigitalPin') });
        return;
      }
      case 'addUartPort': {
        if (!text) return void ctx.reply(en.config.invalidPortPath);
        this.states.set(userId, { kind: 'addUartBaud', name: state.name, port: text });
        await ctx.reply(en.config.step4Uart(state.name, text), { reply_markup: baudKeyboard() });
        return;
      }
      case 'addUartWarning': {
        const warning = parseIntStrict(text);
        if (warning === null || warning <= 0)
          return void ctx.reply(en.config.invalidNumber);
        this.states.set(userId, {
          kind: 'addUartCritical',
          name: state.name,
          port: state.port,
          baud: state.baud,
          warning,
        });
        await ctx.reply(en.config.criticalQuestion, {
          reply_markup: backCancelKeyboard('addUartWarning'),
        });
        return;
      }
      case 'addUartCritical': {
        const critical = parseIntStrict(text);
        if (critical === null || critical <= 0)
          return void ctx.reply(en.config.invalidNumber);
        if (critical <= state.warning)
          return void ctx.reply(en.config.invalidThresholdOrder(state.warning));
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
        this.states.delete(userId);
        await ctx.reply(
          en.config.addedUart(state.name, state.port, state.baud, state.warning, critical),
        );
        return;
      }
      case 'modifyName': {
        await this.modifySensor.execute({
          currentName: state.currentName,
          patch: { name: text },
        });
        this.states.set(userId, {
          kind: 'modifyMenu',
          sensorId: state.sensorId,
          currentName: text,
        });
        await ctx.reply(en.config.modifiedField('Name'), {
          reply_markup: modifyMenu(await this.lookupType(state.sensorId)),
        });
        return;
      }
      case 'modifyPin': {
        const pin = parseIntStrict(text);
        if (pin === null || pin < 0 || pin > 27) return void ctx.reply(en.config.invalidPinRange);
        const current = await this.sensors.findById(state.sensorId);
        if (!current) throw new SensorNotFoundError(state.currentName);
        const nextConfig = { ...current.config, pin };
        await this.modifySensor.execute({
          currentName: state.currentName,
          patch: { config: nextConfig },
        });
        this.states.set(userId, {
          kind: 'modifyMenu',
          sensorId: state.sensorId,
          currentName: state.currentName,
        });
        await ctx.reply(en.config.modifiedField('Pin'), {
          reply_markup: modifyMenu(current.type),
        });
        return;
      }
      case 'modifyDebounce': {
        const ms = parseIntStrict(text);
        if (ms === null || ms < 0) return void ctx.reply(en.config.invalidDebounce);
        await this.modifySensor.execute({
          currentName: state.currentName,
          patch: { debounceMs: ms },
        });
        this.states.set(userId, {
          kind: 'modifyMenu',
          sensorId: state.sensorId,
          currentName: state.currentName,
        });
        await ctx.reply(en.config.modifiedField('Debounce'), {
          reply_markup: modifyMenu(await this.lookupType(state.sensorId)),
        });
        return;
      }
    }
  }

  // ───────── modify helpers ─────────

  private async modifyFieldPrompt(
    ctx: Context,
    userId: number,
    state: Extract<ConfigState, { kind: 'modifyMenu' }>,
    field: string,
  ): Promise<void> {
    if (field === 'done') {
      this.states.delete(userId);
      await ctx.reply(en.config.modifyDone(state.currentName));
      return;
    }
    if (field === 'name') {
      this.states.set(userId, {
        kind: 'modifyName',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.nameQuestion, {
        reply_markup: backCancelKeyboard('modifyMenu'),
      });
      return;
    }
    if (field === 'pin') {
      this.states.set(userId, {
        kind: 'modifyPin',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      const used = await this.getUsedPinsText();
      await ctx.reply(en.config.pinQuestion(used), {
        reply_markup: backCancelKeyboard('modifyMenu'),
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
        reply_markup: modifyMenu(current.type),
      });
      return;
    }
    if (field === 'steptype') {
      this.states.set(userId, {
        kind: 'modifyStepType',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.stepTypeQuestion, {
        reply_markup: stepTypeKeyboard('modifyMenu'),
      });
      return;
    }
    if (field === 'debounce') {
      this.states.set(userId, {
        kind: 'modifyDebounce',
        sensorId: state.sensorId,
        currentName: state.currentName,
      });
      await ctx.reply(en.config.debouncePrompt, {
        reply_markup: backCancelKeyboard('modifyMenu'),
      });
      return;
    }
    if (field === 'severity') {
      // Stay in modifyMenu state shape — severity callback short-circuits.
      await ctx.reply(en.config.severityQuestion, {
        reply_markup: modifySeverityKeyboard(),
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

  private async handleBack(
    ctx: Context,
    userId: number,
    state: ConfigState,
    target: string,
  ): Promise<void> {
    switch (target) {
      case 'addType': {
        this.states.set(userId, { kind: 'addType' });
        await ctx.reply(en.config.step1, { reply_markup: typeKeyboard() });
        break;
      }
      case 'addName': {
        const type =
          state.kind === 'addDigitalPin' ||
          state.kind === 'addDigitalStepType' ||
          state.kind === 'addDigitalSeverity'
            ? 'digital'
            : 'uart';
        this.states.set(userId, { kind: 'addName', type });
        await ctx.reply(en.config.step2(type), { reply_markup: backCancelKeyboard('addType') });
        break;
      }
      case 'addDigitalPin': {
        if ('name' in state) {
          this.states.set(userId, { kind: 'addDigitalPin', name: state.name });
          await ctx.reply(en.config.step3Digital(state.name, await this.getUsedPinsText()), {
            reply_markup: backCancelKeyboard('addName'),
            parse_mode: 'HTML',
          });
        }
        break;
      }
      case 'addDigitalStepType': {
        if ('name' in state && 'pin' in state) {
          this.states.set(userId, {
            kind: 'addDigitalStepType',
            name: state.name,
            pin: state.pin,
          });
          await ctx.reply(en.config.step4Digital(state.name, state.pin), {
            reply_markup: stepTypeKeyboard('addDigitalPin'),
          });
        }
        break;
      }
      case 'addUartPort': {
        if ('name' in state) {
          this.states.set(userId, { kind: 'addUartPort', name: state.name });
          await ctx.reply(en.config.step3Uart(state.name), {
            reply_markup: backCancelKeyboard('addName'),
          });
        }
        break;
      }
      case 'addUartBaud': {
        if ('name' in state && 'port' in state) {
          this.states.set(userId, {
            kind: 'addUartBaud',
            name: state.name,
            port: state.port,
          });
          await ctx.reply(en.config.step4Uart(state.name, state.port), {
            reply_markup: baudKeyboard(),
          });
        }
        break;
      }
      case 'addUartWarning': {
        if ('name' in state && 'port' in state && 'baud' in state) {
          this.states.set(userId, {
            kind: 'addUartWarning',
            name: state.name,
            port: state.port,
            baud: state.baud,
          });
          await ctx.reply(en.config.step5Uart(state.name, state.port, state.baud), {
            reply_markup: backCancelKeyboard('addUartBaud'),
          });
        }
        break;
      }
      case 'modifyMenu': {
        if (isModifyState(state)) {
          this.states.set(userId, {
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
              { reply_markup: modifyMenu(sensor.type) },
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

  // ───────── errors ─────────

  private async replyError(ctx: Context, err: unknown): Promise<void> {
    if (err instanceof SensorNameExistsError) {
      await ctx.reply(en.config.nameTaken(err.sensorName));
      return;
    }
    if (err instanceof SensorNotFoundError) {
      await ctx.reply(en.config.notFound(err.sensorName));
      return;
    }
    if (err instanceof PinAlreadyInUseError) {
      await ctx.reply(en.config.pinTaken(err.pin, err.owner));
      return;
    }
    if (err instanceof InvalidGpioPinError) {
      await ctx.reply(en.config.invalidPin);
      return;
    }
    if (err instanceof InvalidSensorNameError) {
      await ctx.reply(en.config.invalidName);
      return;
    }
    if (err instanceof DigitalConfigInvalidError) {
      await ctx.reply(`❌ ${err.message}`);
      return;
    }
    if (err instanceof UartConfigInvalidError) {
      await ctx.reply(`❌ ${err.message}`);
      return;
    }
    this.logger.error(`/config failed: ${(err as Error).message}`, (err as Error).stack);
    await ctx.reply(en.common.error('process /config', 'internal error'));
  }
}

// ───────── keyboards ─────────

function typeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Digital', 'cfg:type:digital')
    .text('UART', 'cfg:type:uart')
    .row()
    .text(en.common.cancelButton, 'cfg:cancel');
}

function backCancelKeyboard(backTarget: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(en.common.backButton, `cfg:back:${backTarget}`)
    .text(en.common.cancelButton, 'cfg:cancel');
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
  kb.text(en.common.backButton, `cfg:back:${backTarget}`)
    .text(en.common.cancelButton, 'cfg:cancel');
  return kb;
}

function severityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Info', 'cfg:sev:info')
    .text('Warning', 'cfg:sev:warning')
    .text('Critical', 'cfg:sev:critical')
    .row()
    .text(en.common.backButton, 'cfg:back:addDigitalStepType')
    .text(en.common.cancelButton, 'cfg:cancel');
}

function modifySeverityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Info', 'cfg:msev:info')
    .text('Warning', 'cfg:msev:warning')
    .text('Critical', 'cfg:msev:critical')
    .row()
    .text(en.common.backButton, 'cfg:back:modifyMenu')
    .text(en.common.cancelButton, 'cfg:cancel');
}

function baudKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('9600', 'cfg:baud:9600')
    .text('115200', 'cfg:baud:115200')
    .row()
    .text(en.common.backButton, 'cfg:back:addUartPort')
    .text(en.common.cancelButton, 'cfg:cancel');
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirm', 'cfg:rm:confirm')
    .text('Cancel', 'cfg:rm:cancel');
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
  kb.text(en.common.cancelButton, 'cfg:cancel');
  return kb;
}

// ───────── helpers ─────────

function parseIntStrict(input: string): number | null {
  if (!/^-?\d+$/.test(input)) return null;
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

function isSeverity(value: string): value is SensorSeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function isModifyState(
  state: ConfigState,
): state is Extract<ConfigState, { kind: 'modifyMenu' | 'modifyName' | 'modifyPin' | 'modifyDebounce' | 'modifyStepType' }> {
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
