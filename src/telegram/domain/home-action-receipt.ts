export type HomeActionReceipt =
  | { id: string; userId: number; chatId: number; kind: 'pause-confirmation'; sessionToken: string; status: 'pending' | 'completed'; expiresAt: Date; payload: { hours: 1 | 4 | 8 } }
  | { id: string; userId: number; chatId: number; kind: 'cleanup-confirmation' | 'restart-confirmation'; sessionToken: string; status: 'pending' | 'executing' | 'completed' | 'failed'; expiresAt: Date; payload: Record<never, never> }
  | { id: string; userId: number; chatId: number; kind: 'undo-non-critical-pause'; sessionToken: null; status: 'pending' | 'completed'; expiresAt: Date; payload: { foundationReceiptId: number; expectedRevision: number } }
  | { id: string; userId: number; chatId: number; kind: 'undo-quiet-hours'; sessionToken: null; status: 'pending' | 'completed'; expiresAt: Date; payload: { start: string | null; end: string | null; expectedRevision: number } };

export interface ClaimedExternalAction {
  id: string;
  userId: number;
  chatId: number;
  kind: 'cleanup-confirmation' | 'restart-confirmation';
}

export type UndoReceiptKind = 'undo-non-critical-pause' | 'undo-quiet-hours';

const RECEIPT_ID = /^[A-Za-z0-9_-]{16}$/;

export function isHomeActionReceipt(value: unknown): value is HomeActionReceipt {
  if (!isRecord(value) || !isReceiptId(value.id) || !isSafeInteger(value.userId) || !isSafeInteger(value.chatId)
    || !(value.expiresAt instanceof Date) || Number.isNaN(value.expiresAt.getTime())) return false;
  if (!isRecord(value.payload)) return false;
  if (value.kind === 'pause-confirmation') {
    return (value.status === 'pending' || value.status === 'completed') && typeof value.sessionToken === 'string' && hasKeys(value.payload, ['hours'])
      && (value.payload.hours === 1 || value.payload.hours === 4 || value.payload.hours === 8);
  }
  if (value.kind === 'cleanup-confirmation' || value.kind === 'restart-confirmation') {
    return (value.status === 'pending' || value.status === 'executing' || value.status === 'completed' || value.status === 'failed')
      && typeof value.sessionToken === 'string' && hasKeys(value.payload, []);
  }
  if (value.kind === 'undo-non-critical-pause') {
    return (value.status === 'pending' || value.status === 'completed') && value.sessionToken === null && hasKeys(value.payload, ['foundationReceiptId', 'expectedRevision'])
      && isSafeInteger(value.payload.foundationReceiptId) && isSafeInteger(value.payload.expectedRevision);
  }
  return value.kind === 'undo-quiet-hours' && (value.status === 'pending' || value.status === 'completed') && value.sessionToken === null
    && hasKeys(value.payload, ['start', 'end', 'expectedRevision'])
    && (typeof value.payload.start === 'string' || value.payload.start === null)
    && (typeof value.payload.end === 'string' || value.payload.end === null)
    && isSafeInteger(value.payload.expectedRevision);
}

export function isExternalReceipt(receipt: HomeActionReceipt): receipt is Extract<HomeActionReceipt, { kind: 'cleanup-confirmation' | 'restart-confirmation' }> {
  return receipt.kind === 'cleanup-confirmation' || receipt.kind === 'restart-confirmation';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_ID.test(value);
}
