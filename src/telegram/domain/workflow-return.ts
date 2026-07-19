import type { HomeActionReceipt } from './home-action-receipt';

export type ExternalWorkflow =
  | 'logs' | 'csv' | 'language' | 'help' | 'sensor-add'
  | 'sensor-modify' | 'sensor-remove' | 'sensor-import' | 'sensor-export'
  | 'drive-status' | 'drive-setup' | 'storage-cleanup' | 'health'
  | 'system-update' | 'system-restart' | 'invite' | 'camera'
  | 'ota-update' | 'ota-rollback';

export type WorkflowReturnPhase = 'cancellable' | 'running';
export type WorkflowReturnDestination = 'origin' | 'home';
/** Durable outcome-delivery progress for process-recovered workflows. */
export type WorkflowDeliveryStage =
  | 'pending'
  | 'direct-attempted'
  /** The direct result send was rejected; an outcome notice is still required. */
  | 'direct-failed'
  | 'notice-attempted'
  /** The direct result is durably known before Home restoration starts. */
  | 'direct-delivered'
  /** The outcome notice was durably rendered in the restored Home. */
  | 'notice-delivered'
  /** A silent Home restoration began after a known direct result. */
  | 'restore-attempted'
  /** The silent Home restoration is durably known before receipt completion. */
  | 'restored'
  /** Legacy generic acknowledgement stage. */
  | 'delivered'
  /** Legacy stage written before notice attempts were recorded durably. */
  | 'needs-notice';
export type WorkflowReturnReceipt = Extract<HomeActionReceipt, { kind: 'workflow-return' }>;

const RECEIPT_ID = /^[A-Za-z0-9_-]{16}$/;
const CALLBACK = /^wr:([A-Za-z0-9_-]{16}):(o|h)$/;
const WORKFLOWS = new Set<ExternalWorkflow>([
  'logs', 'csv', 'language', 'help', 'sensor-add',
  'sensor-modify', 'sensor-remove', 'sensor-import', 'sensor-export',
  'drive-status', 'drive-setup', 'storage-cleanup', 'health',
  'system-update', 'system-restart', 'invite', 'camera',
  'ota-update', 'ota-rollback',
]);

export function workflowReturnCallback(
  receiptId: string,
  destination: WorkflowReturnDestination,
): string {
  if (!RECEIPT_ID.test(receiptId) || (destination !== 'origin' && destination !== 'home')) {
    throw new RangeError('Invalid workflow return callback');
  }
  return `wr:${receiptId}:${destination === 'origin' ? 'o' : 'h'}`;
}

export function parseWorkflowReturnCallback(data: string):
  | { receiptId: string; destination: WorkflowReturnDestination }
  | null {
  const match = CALLBACK.exec(data);
  if (!match) return null;
  return { receiptId: match[1], destination: match[2] === 'o' ? 'origin' : 'home' };
}

export function isExternalWorkflow(value: unknown): value is ExternalWorkflow {
  return typeof value === 'string' && WORKFLOWS.has(value as ExternalWorkflow);
}

export function isWorkflowReturnPhase(value: unknown): value is WorkflowReturnPhase {
  return value === 'cancellable' || value === 'running';
}

export function isWorkflowDeliveryStage(value: unknown): value is WorkflowDeliveryStage {
  return value === 'pending' || value === 'direct-attempted' || value === 'direct-failed'
    || value === 'notice-attempted' || value === 'direct-delivered'
    || value === 'notice-delivered' || value === 'restore-attempted'
    || value === 'restored' || value === 'delivered' || value === 'needs-notice';
}

export function canTransitionWorkflowDeliveryStage(
  from: WorkflowDeliveryStage,
  to: Exclude<WorkflowDeliveryStage, 'pending'>,
): boolean {
  return (from === 'pending' && to === 'direct-attempted')
    || (from === 'direct-attempted' && (
      to === 'direct-delivered' || to === 'direct-failed' || to === 'restore-attempted'
    ))
    || (from === 'direct-failed' && (to === 'notice-attempted' || to === 'direct-attempted'))
    || (from === 'needs-notice' && (to === 'notice-attempted' || to === 'direct-attempted'))
    || (from === 'notice-attempted' && (to === 'notice-delivered' || to === 'direct-attempted'))
    || (from === 'direct-delivered' && to === 'restore-attempted')
    || (from === 'delivered' && to === 'restore-attempted')
    || (from === 'restore-attempted' && (to === 'restored' || to === 'direct-attempted'));
}
