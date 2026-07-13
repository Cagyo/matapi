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
    ];

    for (const action of actions) {
      const data = encodeHomeCallback(token, revision, action);
      expect(parseHomeCallback(data)).toEqual({ token, revision, action });
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('round trips maximum safe revision and page within Telegram limits', () => {
    const action: HomeAction = { kind: 'sensors', page: Number.MAX_SAFE_INTEGER };
    const data = encodeHomeCallback(token, Number.MAX_SAFE_INTEGER, action);

    expect(parseHomeCallback(data)).toEqual({
      token,
      revision: Number.MAX_SAFE_INTEGER,
      action,
    });
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
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
  ] as const)('rejects invalid callback components', (invalidToken, revision, action) => {
    expect(() => encodeHomeCallback(invalidToken, revision, action)).toThrow(RangeError);
  });
});
