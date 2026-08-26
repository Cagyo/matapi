import { encodeHomeView, parseHomeView, type HomeView } from './home-session';
import {
  isExternalWorkflow,
  isWorkflowDeliveryStage,
  isWorkflowReturnPhase,
  type ExternalWorkflow,
  type FeatureWorkflowOperation,
  type WorkflowDeliveryStage,
  type WorkflowReturnPhase,
} from './workflow-return';

export type HomeActionReceipt =
  | { id: string; userId: number; chatId: number; kind: 'pause-confirmation'; sessionToken: string; status: 'pending' | 'completed'; expiresAt: Date; payload: { hours: 1 | 4 | 8 } }
  | { id: string; userId: number; chatId: number; kind: 'cleanup-confirmation' | 'restart-confirmation'; sessionToken: string; status: 'pending' | 'executing' | 'completed' | 'failed'; expiresAt: Date; payload: Record<never, never> }
  | { id: string; userId: number; chatId: number; kind: 'undo-non-critical-pause'; sessionToken: null; status: 'pending' | 'completed'; expiresAt: Date; payload: { foundationReceiptId: number; expectedRevision: number } }
  | { id: string; userId: number; chatId: number; kind: 'undo-quiet-hours'; sessionToken: null; status: 'pending' | 'completed'; expiresAt: Date; payload: { start: string | null; end: string | null; expectedRevision: number } }
  | {
    id: string;
    userId: number;
    chatId: number;
    kind: 'workflow-return';
    sessionToken: string | null;
    status: 'pending' | 'executing' | 'returned' | 'completed';
    expiresAt: Date;
    payload: WorkflowReturnPayload;
  };

interface WorkflowReturnPayloadBase {
  phase: WorkflowReturnPhase;
  originSource: 'captured' | 'natural-parent';
  origin: HomeView;
}

/** Strict workflow discriminator: only feature receipts may carry an operation. */
export type WorkflowReturnPayload =
  | (WorkflowReturnPayloadBase & {
    workflow: Exclude<ExternalWorkflow, 'feature'>;
    /** Absent on receipts written before durable outcome delivery existed. */
    deliveryStage?: WorkflowDeliveryStage;
    operation?: never;
  })
  | (WorkflowReturnPayloadBase & {
    workflow: 'feature';
    /** New feature receipts always persist delivery recovery state. */
    deliveryStage: WorkflowDeliveryStage;
    operation?: never;
  })
  | (WorkflowReturnPayloadBase & {
    workflow: 'feature';
    deliveryStage: WorkflowDeliveryStage;
    operation: FeatureWorkflowOperation;
  });

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
  if (value.kind === 'workflow-return') {
    return hasOnlyKeys(value, ['id', 'userId', 'chatId', 'kind', 'sessionToken', 'status', 'expiresAt', 'payload'])
      && (typeof value.sessionToken === 'string' || value.sessionToken === null)
      && (value.status === 'pending' || value.status === 'executing' || value.status === 'returned' || value.status === 'completed')
      && hasWorkflowReturnPayloadKeys(value.payload)
      && isExternalWorkflow(value.payload.workflow)
      && isWorkflowReturnPhase(value.payload.phase)
      && isWorkflowPayloadShape(value.payload)
      && (value.payload.deliveryStage === undefined || isWorkflowDeliveryStage(value.payload.deliveryStage))
      && (value.payload.originSource === 'captured' || value.payload.originSource === 'natural-parent')
      && isCanonicalHomeView(value.payload.origin);
  }
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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasWorkflowReturnPayloadKeys(value: Record<string, unknown>): boolean {
  if (value.workflow === 'feature') {
    return hasKeys(value, ['workflow', 'phase', 'originSource', 'origin', 'deliveryStage'])
      || hasKeys(value, ['workflow', 'phase', 'originSource', 'origin', 'operation', 'deliveryStage']);
  }
  return hasKeys(value, ['workflow', 'phase', 'originSource', 'origin'])
    || hasKeys(value, ['workflow', 'phase', 'originSource', 'origin', 'deliveryStage']);
}

function isWorkflowPayloadShape(value: Record<string, unknown>): boolean {
  if (value.workflow !== 'feature') return value.operation === undefined;
  return value.operation === undefined || isFeatureWorkflowOperation(value.operation);
}

function isFeatureWorkflowOperation(value: unknown): value is FeatureWorkflowOperation {
  return isRecord(value)
    && hasKeys(value, ['kind', 'feature', 'action', 'expectedInstalled', 'expectedEnabled', 'expectedAttentionReason'])
    && value.kind === 'feature-mutation'
    && (value.feature === 'digital' || value.feature === 'uart' || value.feature === 'zigbee' || value.feature === 'motion' || value.feature === 'rtsp')
    && (value.action === 'install' || value.action === 'reinstall' || value.action === 'enable'
      || value.action === 'disable' || value.action === 'verify')
    && typeof value.expectedInstalled === 'boolean'
    && typeof value.expectedEnabled === 'boolean'
    && (value.expectedAttentionReason === null || value.expectedAttentionReason === 'install-failed'
      || value.expectedAttentionReason === 'partial-state-uncertain'
      || value.expectedAttentionReason === 'readiness-failed'
      || value.expectedAttentionReason === 'restart-required');
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isReceiptId(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_ID.test(value);
}

function isCanonicalHomeView(value: unknown): value is HomeView {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  try {
    const encoded = encodeHomeView(value as HomeView);
    const parsed = parseHomeView(value.kind, encoded.sensorPage, encoded.payload, encoded.checking);
    return parsed !== null && hasExactStructure(parsed, value);
  } catch {
    return false;
  }
}

function hasExactStructure(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index]
    && hasExactStructure(
      (left as Record<PropertyKey, unknown>)[key],
      (right as Record<PropertyKey, unknown>)[key],
    ));
}
