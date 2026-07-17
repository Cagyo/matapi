import type { HomeActionReceipt } from './home-action-receipt';

export type ExternalWorkflow =
  | 'logs' | 'csv' | 'language' | 'help' | 'sensor-add'
  | 'sensor-modify' | 'sensor-remove' | 'sensor-import' | 'sensor-export'
  | 'drive-status' | 'drive-setup' | 'storage-cleanup' | 'health'
  | 'system-update' | 'system-restart' | 'invite' | 'camera';

export type WorkflowReturnPhase = 'cancellable' | 'running';
export type WorkflowReturnDestination = 'origin' | 'home';
/** Durable outcome-delivery progress for process-recovered workflows. */
export type WorkflowDeliveryStage =
  | 'pending'
  | 'direct-attempted'
  | 'notice-attempted'
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
  return value === 'pending' || value === 'direct-attempted' || value === 'notice-attempted'
    || value === 'delivered' || value === 'needs-notice';
}

export function canTransitionWorkflowDeliveryStage(
  from: WorkflowDeliveryStage,
  to: Exclude<WorkflowDeliveryStage, 'pending'>,
): boolean {
  return (from === 'pending' && to === 'direct-attempted')
    || (from === 'direct-attempted' && (to === 'delivered' || to === 'notice-attempted'))
    || (from === 'needs-notice' && to === 'notice-attempted')
    || (from === 'notice-attempted' && to === 'delivered');
}
