export const HOME_PENDING_TTL_MS = 60_000;
export const MAX_HOME_VIEW_PAYLOAD_BYTES = 2048;

export interface NotificationTargetRef {
  kind: 'sensor' | 'camera';
  id: string;
}

export type HomeView =
  | { kind: 'home'; checking: boolean }
  | { kind: 'sensors'; page: number; checking: boolean }
  | { kind: 'notifications' }
  | { kind: 'notification-targets'; page: number; targets: readonly NotificationTargetRef[] }
  | { kind: 'notification-target'; page: number; target: NotificationTargetRef }
  | { kind: 'pause-duration' }
  | { kind: 'pause-confirmation'; hours: 1 | 4 | 8; receiptId: string }
  | { kind: 'more' }
  | { kind: 'history' }
  | { kind: 'admin-tools' }
  | { kind: 'admin-sensor-setup' }
  | { kind: 'admin-storage' }
  | { kind: 'admin-system' }
  | { kind: 'confirmation'; action: 'cleanup' | 'restart'; receiptId: string }
  | { kind: 'cleanup-result'; outcome: 'executed' | 'in-progress' | 'failed'; threshold: number | null };

export interface EncodedHomeView {
  sensorPage: number | null;
  payload: string | null;
  checking: boolean | null;
}

const RECEIPT_ID = /^[A-Za-z0-9_-]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeHomeView(view: HomeView): EncodedHomeView {
  if (view.kind === 'home') return { sensorPage: null, payload: null, checking: view.checking };
  if (view.kind === 'sensors') return { sensorPage: view.page, payload: null, checking: view.checking };
  const { kind: _kind, ...payload } = view;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HOME_VIEW_PAYLOAD_BYTES
    || parseHomeView(view.kind, null, serialized, null) === null) {
    throw new RangeError('Home view payload is not canonical and bounded');
  }
  return { sensorPage: null, payload: serialized, checking: null };
}

/** Strict database boundary codec. Any non-canonical persisted row is closed. */
export function parseHomeView(
  kind: string,
  sensorPage: number | null,
  payload: string | null,
  checking: boolean | null,
): HomeView | null {
  if (kind === 'home' && checking !== null && sensorPage === null && payload === null) {
    return { kind, checking };
  }
  if (kind === 'sensors' && checking !== null && isPage(sensorPage) && payload === null) {
    return { kind, page: sensorPage, checking };
  }
  if (sensorPage !== null || checking !== null || payload === null || Buffer.byteLength(payload, 'utf8') > MAX_HOME_VIEW_PAYLOAD_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return null; }
  const parsed = parseSliceThreeHomeView(kind, value);
  if (!parsed) return null;
  const { kind: _kind, ...canonicalPayload } = parsed;
  return JSON.stringify(canonicalPayload) === payload ? parsed : null;
}

function parseSliceThreeHomeView(kind: string, value: unknown): HomeView | null {
  if (!isRecord(value)) return null;
  switch (kind) {
    case 'notifications': return hasKeys(value, []) ? { kind } : null;
    case 'notification-targets': {
      if (!hasKeys(value, ['page', 'targets']) || !isPage(value.page) || !Array.isArray(value.targets) || value.targets.length > 8) return null;
      const targets = value.targets.map(parseTarget);
      if (targets.some((target) => target === null)) return null;
      const validTargets = targets as NotificationTargetRef[];
      return new Set(validTargets.map((target) => `${target.kind}:${target.id}`)).size === validTargets.length
        ? { kind, page: value.page, targets: validTargets } : null;
    }
    case 'notification-target': {
      if (!hasKeys(value, ['page', 'target']) || !isPage(value.page)) return null;
      const target = parseTarget(value.target);
      return target ? { kind, page: value.page, target } : null;
    }
    case 'pause-duration': case 'more': case 'history': case 'admin-tools': case 'admin-sensor-setup': case 'admin-storage': case 'admin-system':
      return hasKeys(value, []) ? { kind } : null;
    case 'pause-confirmation':
      return hasKeys(value, ['hours', 'receiptId']) && (value.hours === 1 || value.hours === 4 || value.hours === 8) && isReceiptId(value.receiptId)
        ? { kind, hours: value.hours, receiptId: value.receiptId } : null;
    case 'confirmation':
      return hasKeys(value, ['action', 'receiptId']) && (value.action === 'cleanup' || value.action === 'restart') && isReceiptId(value.receiptId)
        ? { kind, action: value.action, receiptId: value.receiptId } : null;
    case 'cleanup-result':
      return hasKeys(value, ['outcome', 'threshold'])
        && (value.outcome === 'executed' || value.outcome === 'in-progress' || value.outcome === 'failed')
        && (value.threshold === null || (typeof value.threshold === 'number' && Number.isSafeInteger(value.threshold) && value.threshold >= 0))
        ? { kind, outcome: value.outcome, threshold: value.threshold } : null;
    default: return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function isPage(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_ID.test(value);
}

function parseTarget(value: unknown): NotificationTargetRef | null {
  return isRecord(value) && hasKeys(value, ['kind', 'id'])
    && (value.kind === 'sensor' || value.kind === 'camera')
    && typeof value.id === 'string' && UUID.test(value.id)
    ? { kind: value.kind, id: value.id } : null;
}

export interface HomeIdentity {
  userId: number;
  chatId: number;
  messageId: number;
  token: string;
  revision: number;
}

export interface HomeReservation {
  kind: 'new' | 'edit';
  userId: number;
  chatId: number;
  messageId: number | null;
  token: string;
  revision: number;
  view: HomeView;
  expiresAt: Date;
}

export type ReserveEditResult =
  | { kind: 'reserved'; reservation: HomeReservation }
  | { kind: 'stale' | 'closed' };

export type PromoteResult =
  | { kind: 'promoted'; active: HomeIdentity; previous: HomeIdentity | null }
  | { kind: 'lost' };

export type ValidateHomeResult =
  | { kind: 'accepted'; active: HomeIdentity; view: HomeView }
  | { kind: 'updating' | 'stale' | 'closed' };
