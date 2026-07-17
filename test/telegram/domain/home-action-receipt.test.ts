import { describe, expect, it } from 'vitest';
import {
  isHomeActionReceipt,
  type HomeActionReceipt,
} from '../../../src/telegram/domain/home-action-receipt';
import type {
  ExternalWorkflow,
  WorkflowReturnPhase,
  WorkflowReturnReceipt,
} from '../../../src/telegram/domain/workflow-return';

const WORKFLOWS: readonly ExternalWorkflow[] = [
  'logs', 'csv', 'language', 'help', 'sensor-add',
  'sensor-modify', 'sensor-remove', 'sensor-import', 'sensor-export',
  'drive-status', 'drive-setup', 'storage-cleanup', 'health',
  'system-update', 'system-restart', 'invite', 'camera',
];
const PHASES: readonly WorkflowReturnPhase[] = ['cancellable', 'running'];
const STATUSES: readonly WorkflowReturnReceipt['status'][] = ['pending', 'executing', 'returned', 'completed'];

function receipt(overrides: Partial<WorkflowReturnReceipt> = {}): WorkflowReturnReceipt {
  return {
    id: 'AbCdEf0123_-xyZ9',
    userId: 100,
    chatId: 200,
    kind: 'workflow-return',
    sessionToken: '0123456789abcdef',
    status: 'pending',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    payload: {
      workflow: 'logs',
      phase: 'cancellable',
      originSource: 'captured',
      origin: { kind: 'history' },
    },
    ...overrides,
  };
}

describe('Workflow return receipt validation', () => {
  it.each(WORKFLOWS)('accepts the %s workflow', (workflow) => {
    expect(isHomeActionReceipt(receipt({ payload: { ...receipt().payload, workflow } }))).toBe(true);
  });

  it.each(PHASES)('accepts the %s phase', (phase) => {
    expect(isHomeActionReceipt(receipt({ payload: { ...receipt().payload, phase } }))).toBe(true);
  });

  it.each(['pending', 'direct-attempted', 'notice-attempted', 'delivered', 'needs-notice'] as const)(
    'accepts the %s durable delivery stage while retaining legacy stage-less receipts',
    (deliveryStage) => {
      const staged = {
        ...receipt(),
        payload: { ...receipt().payload, deliveryStage },
      };

      expect(isHomeActionReceipt(staged)).toBe(true);
      expect(isHomeActionReceipt(receipt())).toBe(true);
    },
  );

  it.each(STATUSES)('accepts the %s status', (status) => {
    expect(isHomeActionReceipt(receipt({ status }))).toBe(true);
  });

  it.each([
    ['captured', '0123456789abcdef', { kind: 'admin-cleanup-threshold' }],
    ['natural-parent', null, { kind: 'home', checking: false }],
  ] as const)('accepts the %s origin contract', (originSource, sessionToken, origin) => {
    expect(isHomeActionReceipt(receipt({
      sessionToken,
      payload: { ...receipt().payload, originSource, origin },
    }))).toBe(true);
  });

  it('requires the exact canonical payload key order', () => {
    const valid = receipt();
    const reordered = {
      phase: valid.payload.phase,
      workflow: valid.payload.workflow,
      originSource: valid.payload.originSource,
      origin: valid.payload.origin,
    };

    expect(isHomeActionReceipt({ ...valid, payload: reordered })).toBe(false);
  });

  it.each([
    { workflow: 'unknown' },
    { phase: 'finished' },
    { originSource: 'direct' },
    { origin: { kind: 'unknown' } },
    { origin: { kind: 'home', checking: 'false' } },
    { origin: { checking: false, kind: 'home' } },
    { origin: { kind: 'history', extra: true } },
  ])('rejects malformed workflow payload fields: %j', (override) => {
    expect(isHomeActionReceipt(receipt({
      payload: { ...receipt().payload, ...override } as WorkflowReturnReceipt['payload'],
    }))).toBe(false);
  });

  it.each([
    { kind: 'history', unknown: undefined },
    {
      kind: 'notification-target',
      page: 0,
      target: {
        kind: 'sensor',
        id: '123e4567-e89b-12d3-a456-426614174000',
        unknown: undefined,
      },
    },
  ])('rejects Home views with structurally unknown undefined properties: %j', (origin) => {
    expect(isHomeActionReceipt(receipt({
      payload: { ...receipt().payload, origin } as WorkflowReturnReceipt['payload'],
    }))).toBe(false);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects cleanup result Home views with the non-finite threshold %s', (threshold) => {
    expect(isHomeActionReceipt(receipt({
      payload: {
        ...receipt().payload,
        origin: { kind: 'cleanup-result', outcome: 'executed', threshold },
      },
    }))).toBe(false);
  });

  it.each([
    { id: 'short' },
    { id: 'AbCdEf0123_-xy+9' },
    { userId: 1.5 },
    { chatId: Number.POSITIVE_INFINITY },
    { status: 'failed' },
    { expiresAt: new Date(Number.NaN) },
    { expiresAt: '2030-01-01T00:00:00.000Z' },
  ])('rejects invalid receipt fields: %j', (override) => {
    expect(isHomeActionReceipt({ ...receipt(), ...override })).toBe(false);
  });

  it('rejects unknown receipt and payload keys', () => {
    expect(isHomeActionReceipt({ ...receipt(), unknown: true })).toBe(false);
    expect(isHomeActionReceipt({ ...receipt(), payload: { ...receipt().payload, unknown: true } })).toBe(false);
  });

  it('keeps the workflow return receipt assignable to the shared receipt union', () => {
    const value: HomeActionReceipt = receipt();
    expect(value.kind).toBe('workflow-return');
  });
});
