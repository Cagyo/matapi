import { describe, expect, it } from 'vitest';
import {
  encodeHomeCallback,
  HomeAction,
  parseHomeCallback,
} from '../../../src/telegram/domain/home-callback';

const token = 'AbCdEfGhIjKlMn_-';

describe('Home callback codec', () => {
  it.each([1, Number.MAX_SAFE_INTEGER])('round trips every action at revision %i', (revision) => {
    const actions: HomeAction[] = [
      { kind: 'home' },
      { kind: 'sensors', page: 0 },
      { kind: 'camera' },
      { kind: 'notifications' },
      { kind: 'more' },
      { kind: 'check' },
      { kind: 'close' },
      { kind: 'back' },
      { kind: 'notification-targets', page: 0 },
      { kind: 'notification-target', index: 0 },
      { kind: 'notification-target-mute' },
      { kind: 'notification-target-unmute' },
      { kind: 'pause-duration' },
      { kind: 'pause-hours', hours: 1 },
      { kind: 'pause-hours', hours: 4 },
      { kind: 'pause-hours', hours: 8 },
      { kind: 'confirm-pause', receiptId: token },
      { kind: 'confirm-cleanup', receiptId: token },
      { kind: 'confirm-restart', receiptId: token },
      { kind: 'undo-pause', receiptId: token },
      { kind: 'undo-quiet-hours', receiptId: token },
      { kind: 'quiet-hours', preset: '22-07' },
      { kind: 'quiet-hours', preset: '23-06' },
      { kind: 'quiet-hours', preset: '00-08' },
      { kind: 'quiet-hours', preset: 'off' },
      { kind: 'history' },
      { kind: 'history-logs' },
      { kind: 'history-csv' },
      { kind: 'settings' },
      { kind: 'help' },
      { kind: 'admin-tools' },
      { kind: 'admin-sensor-setup' },
      { kind: 'admin-storage' },
      { kind: 'admin-system' },
      { kind: 'config-add' },
      { kind: 'config-modify' },
      { kind: 'config-remove' },
      { kind: 'config-import' },
      { kind: 'config-export' },
      { kind: 'drive-status' },
      { kind: 'drive-connect' },
      { kind: 'system-health' },
      { kind: 'system-packages' },
      { kind: 'invite' },
      { kind: 'cleanup' },
      { kind: 'restart' },
      { kind: 'auto-clean-threshold', value: 70 },
      { kind: 'auto-clean-threshold', value: 75 },
      { kind: 'auto-clean-threshold', value: 80 },
      { kind: 'auto-clean-threshold', value: 85 },
      { kind: 'auto-clean-threshold', value: 90 },
    ];

    for (const action of actions) {
      const data = encodeHomeCallback(token, revision, action);
      expect(parseHomeCallback(data)).toEqual({ token, revision, action });
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('round trips maximum safe revision and page within Telegram limits', () => {
    for (const action of [
      { kind: 'sensors', page: Number.MAX_SAFE_INTEGER },
      { kind: 'notification-targets', page: Number.MAX_SAFE_INTEGER },
      { kind: 'notification-target', index: Number.MAX_SAFE_INTEGER },
    ] as const) {
      const data = encodeHomeCallback(token, Number.MAX_SAFE_INTEGER, action);
      expect(parseHomeCallback(data)).toEqual({ token, revision: Number.MAX_SAFE_INTEGER, action });
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('uses separate wire codes for every receipt action', () => {
    const receiptActions: HomeAction[] = [
      { kind: 'confirm-pause', receiptId: token },
      { kind: 'confirm-cleanup', receiptId: token },
      { kind: 'confirm-restart', receiptId: token },
      { kind: 'undo-pause', receiptId: token },
      { kind: 'undo-quiet-hours', receiptId: token },
    ];

    expect(new Set(receiptActions.map((action) => encodeHomeCallback(token, 1, action))).size)
      .toBe(receiptActions.length);
  });

  it.each([
    'h',
    `h:${token}:1`,
    `h:${token}::h`,
    `h:${token}:1:h:`,
    `h:${token}:1:h:extra`,
    `h:${token}:1:s`,
    `h:${token}:1:s:0:extra`,
    `h:${token}:1:z`,
    `h:${token}:0:h`,
    `h:${token}:-1:h`,
    `h:${token}:${(Number.MAX_SAFE_INTEGER + 1).toString(36)}:h`,
    `h:${token}:1:s:-1`,
    `h:${token}:1:s:${(Number.MAX_SAFE_INTEGER + 1).toString(36)}`,
    `h:${token}:1:nt:-1`,
    `h:${token}:1:ni:${(Number.MAX_SAFE_INTEGER + 1).toString(36)}`,
    `h:${token}:1:ph:2`,
    `h:${token}:1:ph:1:extra`,
    `h:${token}:1:ac:72`,
    `h:${token}:1:ac:70:extra`,
    `h:${token}:1:cp:bad`,
    `h:${token}:1:cc:AbCdEfGhIjKlMn+/`,
    `h:${token}:1:cr:${token}:extra`,
    `h:${token}:1:uq:${token}:extra`,
    `h:${token}:1:q:21-07`,
    `h:${token}:1:q:22-07:extra`,
    `h:${token}:1::h`,
    `h:${token.slice(0, 15)}:1:h`,
    `h:${token}x:1:h`,
    'h:AbCdEfGhIjKlMn+/:1:h',
  ])('returns null for malformed callback data: %s', (data) => {
    expect(parseHomeCallback(data)).toBeNull();
  });

  it.each([
    [token, 0, { kind: 'home' }],
    [token, -1, { kind: 'home' }],
    [token, Number.MAX_SAFE_INTEGER + 1, { kind: 'home' }],
    ['bad', 1, { kind: 'home' }],
    [token, 1, { kind: 'sensors', page: -1 }],
    [token, 1, { kind: 'sensors', page: Number.MAX_SAFE_INTEGER + 1 }],
    [token, 1, { kind: 'notification-targets', page: -1 }],
    [token, 1, { kind: 'notification-target', index: Number.MAX_SAFE_INTEGER + 1 }],
    [token, 1, { kind: 'pause-hours', hours: 2 }],
    [token, 1, { kind: 'auto-clean-threshold', value: 72 }],
    [token, 1, { kind: 'confirm-pause', receiptId: 'bad' }],
    [token, 1, { kind: 'quiet-hours', preset: '21-07' }],
  ] as const)('rejects invalid callback components', (invalidToken, revision, action) => {
    expect(() => encodeHomeCallback(invalidToken, revision, action)).toThrow(RangeError);
  });

  it.each([null, undefined, 42, 'home'])('rejects non-object action %s with RangeError', (action) => {
    expect(() => encodeHomeCallback(token, 1, action as unknown as HomeAction)).toThrow(RangeError);
  });
});
