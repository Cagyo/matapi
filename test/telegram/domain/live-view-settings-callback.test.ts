import { describe, expect, it } from 'vitest';
import {
  liveViewSettingsCallback,
  parseLiveViewSettingsCallback,
  type LiveViewSettingsCallbackAction,
} from '../../../src/telegram/domain/live-view-settings-callback';

const RECEIPT_ID = 'AbCdEfGhIjKlMnOp';

describe('Live view settings callback codec', () => {
  it.each([
    [{ kind: 'enable' }, 'e'],
    [{ kind: 'disable' }, 'd'],
    [{ kind: 'networks' }, 'n'],
    [{ kind: 'manual' }, 'm'],
    [{ kind: 'review' }, 'v'],
    [{ kind: 'save' }, 's'],
    [{ kind: 'retry-restart' }, 't'],
    [{ kind: 'confirm-normalized' }, 'c'],
    [{ kind: 'suggestion-page', page: 3 }, 'p3'],
    [{ kind: 'add-suggestion', selector: 7 }, 'a7'],
    [{ kind: 'remove-entry', selector: 15 }, 'r15'],
  ] as const satisfies readonly [LiveViewSettingsCallbackAction, string][])('round trips %j', (action, wireAction) => {
    const callback = liveViewSettingsCallback(RECEIPT_ID, action);

    expect(callback).toBe(`lvs:${RECEIPT_ID}:${wireAction}`);
    expect(parseLiveViewSettingsCallback(callback)).toEqual({ receiptId: RECEIPT_ID, action });
    expect(Buffer.byteLength(callback, 'utf8')).toBeLessThanOrEqual(64);
  });

  it.each([
    '',
    'lvs',
    `lvs:${RECEIPT_ID}`,
    `lvs:${RECEIPT_ID}:`,
    `lvs:${RECEIPT_ID}:x`,
    `lvs:${RECEIPT_ID}:p`,
    `lvs:${RECEIPT_ID}:p00`,
    `lvs:${RECEIPT_ID}:p04`,
    `lvs:${RECEIPT_ID}:a00`,
    `lvs:${RECEIPT_ID}:a08`,
    `lvs:${RECEIPT_ID}:r00`,
    `lvs:${RECEIPT_ID}:r16`,
    `lvs:${RECEIPT_ID}:p1x`,
    `lvs:${RECEIPT_ID}:e:extra`,
    `lvs:${RECEIPT_ID.slice(0, 15)}:e`,
    `lvs:${RECEIPT_ID}x:e`,
    'lvs:AbCdEfGhIjKlMn+p:e',
    `lvs:${RECEIPT_ID}:${'x'.repeat(47)}`,
  ])('rejects malformed callback data: %s', (data) => {
    expect(parseLiveViewSettingsCallback(data)).toBeNull();
  });

  it.each([
    ['', { kind: 'enable' }],
    ['short', { kind: 'enable' }],
    ['AbCdEfGhIjKlMn+p', { kind: 'enable' }],
    [RECEIPT_ID, { kind: 'suggestion-page', page: -1 }],
    [RECEIPT_ID, { kind: 'suggestion-page', page: 4 }],
    [RECEIPT_ID, { kind: 'add-suggestion', selector: 8 }],
    [RECEIPT_ID, { kind: 'remove-entry', selector: 16 }],
  ] as const)('rejects invalid callback components', (receiptId, action) => {
    expect(() => liveViewSettingsCallback(receiptId, action)).toThrow(RangeError);
  });
});
