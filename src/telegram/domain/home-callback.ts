export const HOME_TOKEN_BYTES = 12;
export const HOME_TOKEN_LENGTH = 16;
export const OPEN_NEW_HOME_CALLBACK = 'ho';

export type HomeAction =
  | { kind: 'home' }
  | { kind: 'sensors'; page: number }
  | { kind: 'camera' }
  | { kind: 'notifications' }
  | { kind: 'more' }
  | { kind: 'check' }
  /** One-release compatibility for legacy `x` buttons; never encode it. */
  | { kind: 'refresh' }
  | { kind: 'back' }
  | { kind: 'notification-targets'; page: number }
  | { kind: 'notification-target'; index: number }
  | { kind: 'notification-target-mute' }
  | { kind: 'notification-target-unmute' }
  | { kind: 'pause-duration' }
  | { kind: 'pause-hours'; hours: 1 | 4 | 8 }
  | { kind: 'confirm-pause'; receiptId: string }
  | { kind: 'confirm-cleanup'; receiptId: string }
  | { kind: 'confirm-restart'; receiptId: string }
  | { kind: 'undo-pause'; receiptId: string }
  | { kind: 'undo-quiet-hours'; receiptId: string }
  | { kind: 'quiet-hours'; preset: '22-07' | '23-06' | '00-08' | 'off' }
  | { kind: 'history' }
  | { kind: 'history-logs' }
  | { kind: 'history-csv' }
  | { kind: 'settings' }
  | { kind: 'help' }
  | { kind: 'admin-tools' }
  | { kind: 'admin-sensor-setup' }
  | { kind: 'admin-storage' }
  | { kind: 'admin-system' }
  | { kind: 'admin-cleanup-threshold' }
  | { kind: 'config-add' }
  | { kind: 'config-modify' }
  | { kind: 'config-remove' }
  | { kind: 'config-import' }
  | { kind: 'config-export' }
  | { kind: 'drive-status' }
  | { kind: 'drive-connect' }
  | { kind: 'system-health' }
  | { kind: 'system-packages' }
  | { kind: 'invite' }
  | { kind: 'cleanup' }
  | { kind: 'restart' }
  | { kind: 'auto-clean-threshold'; value: 70 | 75 | 80 | 85 | 90 };

export interface ParsedHomeCallback {
  token: string;
  revision: number;
  action: HomeAction;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const BASE_36_PATTERN = /^[0-9a-z]+$/;
const MAX_CALLBACK_BYTES = 64;
const PAUSE_HOURS = new Set([1, 4, 8]);
const AUTO_CLEAN_THRESHOLDS = new Set([70, 75, 80, 85, 90]);
const QUIET_HOURS_PRESETS = new Set(['22-07', '23-06', '00-08', 'off']);

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new RangeError('Home callback token must be a 16-character URL-safe value');
  }
}

function assertSafeInteger(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`Home callback ${name} is invalid`);
  }
}

function actionParts(action: HomeAction): string[] {
  if (typeof action !== 'object' || action === null) {
    throw new RangeError('Home callback action is invalid');
  }

  switch (action.kind) {
    case 'home':
      return ['h'];
    case 'sensors':
      assertSafeInteger(action.page, 0, 'page');
      return ['s', action.page.toString(36)];
    case 'camera':
      return ['c'];
    case 'notifications':
      return ['n'];
    case 'more':
      return ['m'];
    case 'check':
      return ['k'];
    case 'refresh':
      throw new RangeError('Legacy Home refresh actions are decode-only');
    case 'back':
      return ['b'];
    case 'notification-targets':
      assertSafeInteger(action.page, 0, 'page');
      return ['nt', action.page.toString(36)];
    case 'notification-target':
      assertSafeInteger(action.index, 0, 'index');
      return ['ni', action.index.toString(36)];
    case 'notification-target-mute':
      return ['nm'];
    case 'notification-target-unmute':
      return ['nu'];
    case 'pause-duration':
      return ['pd'];
    case 'pause-hours':
      if (!PAUSE_HOURS.has(action.hours)) throw new RangeError('Home callback pause duration is invalid');
      return ['ph', String(action.hours)];
    case 'confirm-pause':
      assertToken(action.receiptId);
      return ['cp', action.receiptId];
    case 'confirm-cleanup':
      assertToken(action.receiptId);
      return ['cc', action.receiptId];
    case 'confirm-restart':
      assertToken(action.receiptId);
      return ['cr', action.receiptId];
    case 'undo-pause':
      assertToken(action.receiptId);
      return ['up', action.receiptId];
    case 'undo-quiet-hours':
      assertToken(action.receiptId);
      return ['uq', action.receiptId];
    case 'quiet-hours':
      if (!QUIET_HOURS_PRESETS.has(action.preset)) throw new RangeError('Home callback quiet-hours preset is invalid');
      return ['q', action.preset];
    case 'history':
      return ['hi'];
    case 'history-logs':
      return ['hl'];
    case 'history-csv':
      return ['hv'];
    case 'settings':
      return ['st'];
    case 'help':
      return ['he'];
    case 'admin-tools':
      return ['at'];
    case 'admin-sensor-setup':
      return ['as'];
    case 'admin-storage':
      return ['ab'];
    case 'admin-system':
      return ['ay'];
    case 'admin-cleanup-threshold':
      return ['atc'];
    case 'config-add':
      return ['ca'];
    case 'config-modify':
      return ['cm'];
    case 'config-remove':
      return ['cx'];
    case 'config-import':
      return ['ci'];
    case 'config-export':
      return ['ce'];
    case 'drive-status':
      return ['ds'];
    case 'drive-connect':
      return ['dc'];
    case 'system-health':
      return ['sh'];
    case 'system-packages':
      return ['sp'];
    case 'invite':
      return ['iv'];
    case 'cleanup':
      return ['cl'];
    case 'restart':
      return ['rr'];
    case 'auto-clean-threshold':
      if (!AUTO_CLEAN_THRESHOLDS.has(action.value)) throw new RangeError('Home callback auto-clean threshold is invalid');
      return ['ac', String(action.value)];
    default:
      throw new RangeError('Home callback action is invalid');
  }
}

function parseSafeBase36(value: string, minimum: number): number | null {
  if (!BASE_36_PATTERN.test(value)) return null;
  const parsed = Number.parseInt(value, 36);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed.toString(36) !== value) {
    return null;
  }
  return parsed;
}

export function encodeHomeCallback(
  token: string,
  revision: number,
  action: HomeAction,
): string {
  assertToken(token);
  assertSafeInteger(revision, 1, 'revision');

  const callback = ['h', token, revision.toString(36), ...actionParts(action)].join(':');
  if (Buffer.byteLength(callback, 'utf8') > MAX_CALLBACK_BYTES) {
    throw new RangeError('Home callback exceeds Telegram callback-data limit');
  }
  return callback;
}

export function parseHomeCallback(data: string): ParsedHomeCallback | null {
  try {
    if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) return null;
    const parts = data.split(':');
    if (parts[0] !== 'h' || !TOKEN_PATTERN.test(parts[1] ?? '')) return null;

    const revision = parseSafeBase36(parts[2] ?? '', 1);
    if (revision === null) return null;

    const [prefix, token, , code, value] = parts;
    if (prefix !== 'h' || token === undefined) return null;

    switch (code) {
      case 'h':
        return parts.length === 4 ? { token, revision, action: { kind: 'home' } } : null;
      case 's': {
        if (parts.length !== 5 || value === undefined) return null;
        const parsedPage = parseSafeBase36(value, 0);
        return parsedPage === null
          ? null
          : { token, revision, action: { kind: 'sensors', page: parsedPage } };
      }
      case 'c':
        return parts.length === 4 ? { token, revision, action: { kind: 'camera' } } : null;
      case 'n':
        return parts.length === 4 ? { token, revision, action: { kind: 'notifications' } } : null;
      case 'm':
        return parts.length === 4 ? { token, revision, action: { kind: 'more' } } : null;
      case 'k':
        return parts.length === 4 ? { token, revision, action: { kind: 'check' } } : null;
      case 'x':
        return parts.length === 4 ? { token, revision, action: { kind: 'refresh' } } : null;
      case 'b':
        return parts.length === 4 ? { token, revision, action: { kind: 'back' } } : null;
      case 'nt': {
        if (parts.length !== 5 || value === undefined) return null;
        const parsedPage = parseSafeBase36(value, 0);
        return parsedPage === null ? null : { token, revision, action: { kind: 'notification-targets', page: parsedPage } };
      }
      case 'ni': {
        if (parts.length !== 5 || value === undefined) return null;
        const index = parseSafeBase36(value, 0);
        return index === null ? null : { token, revision, action: { kind: 'notification-target', index } };
      }
      case 'nm': return parts.length === 4 ? { token, revision, action: { kind: 'notification-target-mute' } } : null;
      case 'nu': return parts.length === 4 ? { token, revision, action: { kind: 'notification-target-unmute' } } : null;
      case 'pd': return parts.length === 4 ? { token, revision, action: { kind: 'pause-duration' } } : null;
      case 'ph': {
        if (parts.length !== 5 || value === undefined) return null;
        const hours = Number(value);
        return PAUSE_HOURS.has(hours) && String(hours) === value
          ? { token, revision, action: { kind: 'pause-hours', hours: hours as 1 | 4 | 8 } } : null;
      }
      case 'cp': return parseReceiptAction(parts, token, revision, 'confirm-pause');
      case 'cc': return parseReceiptAction(parts, token, revision, 'confirm-cleanup');
      case 'cr': return parseReceiptAction(parts, token, revision, 'confirm-restart');
      case 'up': return parseReceiptAction(parts, token, revision, 'undo-pause');
      case 'uq': return parseReceiptAction(parts, token, revision, 'undo-quiet-hours');
      case 'q':
        return parts.length === 5 && value !== undefined && QUIET_HOURS_PRESETS.has(value)
          ? { token, revision, action: { kind: 'quiet-hours', preset: value as '22-07' | '23-06' | '00-08' | 'off' } } : null;
      case 'hi': return parts.length === 4 ? { token, revision, action: { kind: 'history' } } : null;
      case 'hl': return parts.length === 4 ? { token, revision, action: { kind: 'history-logs' } } : null;
      case 'hv': return parts.length === 4 ? { token, revision, action: { kind: 'history-csv' } } : null;
      case 'st': return parts.length === 4 ? { token, revision, action: { kind: 'settings' } } : null;
      case 'he': return parts.length === 4 ? { token, revision, action: { kind: 'help' } } : null;
      case 'at': return parts.length === 4 ? { token, revision, action: { kind: 'admin-tools' } } : null;
      case 'as': return parts.length === 4 ? { token, revision, action: { kind: 'admin-sensor-setup' } } : null;
      case 'ab': return parts.length === 4 ? { token, revision, action: { kind: 'admin-storage' } } : null;
      case 'ay': return parts.length === 4 ? { token, revision, action: { kind: 'admin-system' } } : null;
      case 'atc': return parts.length === 4 ? { token, revision, action: { kind: 'admin-cleanup-threshold' } } : null;
      case 'ca': return parts.length === 4 ? { token, revision, action: { kind: 'config-add' } } : null;
      case 'cm': return parts.length === 4 ? { token, revision, action: { kind: 'config-modify' } } : null;
      case 'cx': return parts.length === 4 ? { token, revision, action: { kind: 'config-remove' } } : null;
      case 'ci': return parts.length === 4 ? { token, revision, action: { kind: 'config-import' } } : null;
      case 'ce': return parts.length === 4 ? { token, revision, action: { kind: 'config-export' } } : null;
      case 'ds': return parts.length === 4 ? { token, revision, action: { kind: 'drive-status' } } : null;
      case 'dc': return parts.length === 4 ? { token, revision, action: { kind: 'drive-connect' } } : null;
      case 'sh': return parts.length === 4 ? { token, revision, action: { kind: 'system-health' } } : null;
      case 'sp': return parts.length === 4 ? { token, revision, action: { kind: 'system-packages' } } : null;
      case 'iv': return parts.length === 4 ? { token, revision, action: { kind: 'invite' } } : null;
      case 'cl': return parts.length === 4 ? { token, revision, action: { kind: 'cleanup' } } : null;
      case 'rr': return parts.length === 4 ? { token, revision, action: { kind: 'restart' } } : null;
      case 'ac': {
        if (parts.length !== 5 || value === undefined) return null;
        const threshold = Number(value);
        return AUTO_CLEAN_THRESHOLDS.has(threshold) && String(threshold) === value
          ? { token, revision, action: { kind: 'auto-clean-threshold', value: threshold as 70 | 75 | 80 | 85 | 90 } } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseReceiptAction(
  parts: readonly string[],
  token: string,
  revision: number,
  kind: Extract<HomeAction, { receiptId: string }>['kind'],
): ParsedHomeCallback | null {
  const receiptId = parts[4];
  return parts.length === 5 && receiptId !== undefined && TOKEN_PATTERN.test(receiptId)
    ? { token, revision, action: { kind, receiptId } }
    : null;
}
