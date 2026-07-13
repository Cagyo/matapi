export const HOME_TOKEN_BYTES = 12;
export const HOME_TOKEN_LENGTH = 16;
export const OPEN_NEW_HOME_CALLBACK = 'ho';

export type HomeAction =
  | { kind: 'home' }
  | { kind: 'sensors'; page: number }
  | { kind: 'camera' }
  | { kind: 'notifications' }
  | { kind: 'more' }
  | { kind: 'check' }
  | { kind: 'close' };

export interface ParsedHomeCallback {
  token: string;
  revision: number;
  action: HomeAction;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const BASE_36_PATTERN = /^[0-9a-z]+$/;
const MAX_CALLBACK_BYTES = 64;

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new RangeError('Home callback token must be a 16-character URL-safe value');
  }
}

function assertSafeInteger(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`Home callback ${name} is invalid`);
  }
}

function actionParts(action: HomeAction): string[] {
  if (typeof action !== 'object' || action === null) {
    throw new RangeError('Home callback action is invalid');
  }

  switch (action.kind) {
    case 'home':
      return ['h'];
    case 'sensors':
      assertSafeInteger(action.page, 0, 'page');
      return ['s', action.page.toString(36)];
    case 'camera':
      return ['c'];
    case 'notifications':
      return ['n'];
    case 'more':
      return ['m'];
    case 'check':
      return ['k'];
    case 'close':
      return ['x'];
    default:
      throw new RangeError('Home callback action is invalid');
  }
}

function parseSafeBase36(value: string, minimum: number): number | null {
  if (!BASE_36_PATTERN.test(value)) return null;
  const parsed = Number.parseInt(value, 36);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed.toString(36) !== value) {
    return null;
  }
  return parsed;
}

export function encodeHomeCallback(
  token: string,
  revision: number,
  action: HomeAction,
): string {
  assertToken(token);
  assertSafeInteger(revision, 1, 'revision');

  const callback = ['h', token, revision.toString(36), ...actionParts(action)].join(':');
  if (Buffer.byteLength(callback, 'utf8') > MAX_CALLBACK_BYTES) {
    throw new RangeError('Home callback exceeds Telegram callback-data limit');
  }
  return callback;
}

export function parseHomeCallback(data: string): ParsedHomeCallback | null {
  try {
    const parts = data.split(':');
    if (parts[0] !== 'h' || !TOKEN_PATTERN.test(parts[1] ?? '')) return null;

    const revision = parseSafeBase36(parts[2] ?? '', 1);
    if (revision === null) return null;

    const [prefix, token, , code, page] = parts;
    if (prefix !== 'h' || token === undefined) return null;

    switch (code) {
      case 'h':
        return parts.length === 4 ? { token, revision, action: { kind: 'home' } } : null;
      case 's': {
        if (parts.length !== 5 || page === undefined) return null;
        const parsedPage = parseSafeBase36(page, 0);
        return parsedPage === null
          ? null
          : { token, revision, action: { kind: 'sensors', page: parsedPage } };
      }
      case 'c':
        return parts.length === 4 ? { token, revision, action: { kind: 'camera' } } : null;
      case 'n':
        return parts.length === 4 ? { token, revision, action: { kind: 'notifications' } } : null;
      case 'm':
        return parts.length === 4 ? { token, revision, action: { kind: 'more' } } : null;
      case 'k':
        return parts.length === 4 ? { token, revision, action: { kind: 'check' } } : null;
      case 'x':
        return parts.length === 4 ? { token, revision, action: { kind: 'close' } } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
