export type LiveViewSettingsCallbackAction =
  | { kind: 'enable' | 'disable' | 'networks' | 'manual' | 'review' | 'save' | 'retry-restart' | 'confirm-normalized' }
  | { kind: 'suggestion-page'; page: number }
  | { kind: 'add-suggestion'; selector: number }
  | { kind: 'remove-entry'; selector: number };

const RECEIPT_ID = /^[A-Za-z0-9_-]{16}$/;
const MAX_CALLBACK_BYTES = 64;

export function liveViewSettingsCallback(
  receiptId: string,
  action: LiveViewSettingsCallbackAction,
): string {
  if (!RECEIPT_ID.test(receiptId)) throw new RangeError('Invalid live view settings receipt');
  const callback = `lvs:${receiptId}:${actionCode(action)}`;
  if (Buffer.byteLength(callback, 'utf8') > MAX_CALLBACK_BYTES) {
    throw new RangeError('Live view settings callback exceeds Telegram callback-data limit');
  }
  return callback;
}

export function parseLiveViewSettingsCallback(data: string): {
  receiptId: string;
  action: LiveViewSettingsCallbackAction;
} | null {
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) return null;
  const match = /^lvs:([A-Za-z0-9_-]{16}):(e|d|n|m|v|s|t|c|p[0-3]|a[0-7]|r(?:[0-9]|1[0-5]))$/.exec(data);
  if (!match) return null;
  const action = parseAction(match[2]);
  return action ? { receiptId: match[1], action } : null;
}

function actionCode(action: LiveViewSettingsCallbackAction): string {
  switch (action.kind) {
    case 'enable': return 'e';
    case 'disable': return 'd';
    case 'networks': return 'n';
    case 'manual': return 'm';
    case 'review': return 'v';
    case 'save': return 's';
    case 'retry-restart': return 't';
    case 'confirm-normalized': return 'c';
    case 'suggestion-page':
      if (!Number.isSafeInteger(action.page) || action.page < 0 || action.page > 3) break;
      return `p${action.page}`;
    case 'add-suggestion':
      if (!Number.isSafeInteger(action.selector) || action.selector < 0 || action.selector > 7) break;
      return `a${action.selector}`;
    case 'remove-entry':
      if (!Number.isSafeInteger(action.selector) || action.selector < 0 || action.selector > 15) break;
      return `r${action.selector}`;
  }
  throw new RangeError('Invalid live view settings callback action');
}

function parseAction(code: string): LiveViewSettingsCallbackAction | null {
  switch (code) {
    case 'e': return { kind: 'enable' };
    case 'd': return { kind: 'disable' };
    case 'n': return { kind: 'networks' };
    case 'm': return { kind: 'manual' };
    case 'v': return { kind: 'review' };
    case 's': return { kind: 'save' };
    case 't': return { kind: 'retry-restart' };
    case 'c': return { kind: 'confirm-normalized' };
  }
  if (code.startsWith('p')) return { kind: 'suggestion-page', page: Number(code.slice(1)) };
  if (code.startsWith('a')) return { kind: 'add-suggestion', selector: Number(code.slice(1)) };
  if (code.startsWith('r')) return { kind: 'remove-entry', selector: Number(code.slice(1)) };
  return null;
}
