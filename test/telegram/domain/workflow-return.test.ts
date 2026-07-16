import { describe, expect, it } from 'vitest';
import {
  parseWorkflowReturnCallback,
  workflowReturnCallback,
  type WorkflowReturnDestination,
} from '../../../src/telegram/domain/workflow-return';

const RECEIPT_ID = 'AbCdEf0123_-xyZ9';

describe('Workflow return callback codec', () => {
  it.each([
    ['origin', 'o'],
    ['home', 'h'],
  ] as const)('round trips the %s destination', (destination, wireDestination) => {
    const callback = workflowReturnCallback(RECEIPT_ID, destination);

    expect(callback).toBe(`wr:${RECEIPT_ID}:${wireDestination}`);
    expect(parseWorkflowReturnCallback(callback)).toEqual({ receiptId: RECEIPT_ID, destination });
    expect(Buffer.byteLength(callback, 'utf8')).toBeLessThanOrEqual(64);
  });

  it.each([
    '',
    'wr',
    `wr:${RECEIPT_ID}`,
    `wr:${RECEIPT_ID}:`,
    `wr:${RECEIPT_ID}:x`,
    `wr:${RECEIPT_ID}:origin`,
    `wr:${RECEIPT_ID}:o:extra`,
    `wr:${RECEIPT_ID}:o `,
    `wr:${RECEIPT_ID}:o\n`,
    `wr:${RECEIPT_ID}:h\r\n`,
    `wr:${RECEIPT_ID.slice(0, 15)}:o`,
    `wr:${RECEIPT_ID}x:o`,
    'wr:AbCdEf0123_-xy+9:o',
    'wr:Абвгдежзийклмноп:o',
  ])('rejects malformed or non-canonical callback data: %s', (data) => {
    expect(parseWorkflowReturnCallback(data)).toBeNull();
  });

  it.each([
    ['', 'origin'],
    ['short', 'origin'],
    [`${RECEIPT_ID}x`, 'origin'],
    ['AbCdEf0123_-xy+9', 'origin'],
    ['Абвгдежзийклмноп', 'origin'],
    [RECEIPT_ID, 'elsewhere'],
  ] as const)('rejects invalid callback components', (receiptId, destination) => {
    expect(() => workflowReturnCallback(receiptId, destination as WorkflowReturnDestination)).toThrow(RangeError);
  });
});
