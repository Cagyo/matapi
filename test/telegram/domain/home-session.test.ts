import { describe, expect, it } from 'vitest';
import {
  encodeHomeView,
  MAX_HOME_VIEW_PAYLOAD_BYTES,
  parseHomeView,
  type HomeView,
} from '../../../src/telegram/domain/home-session';

const TARGETS = [
  { kind: 'sensor', id: 'a0a0a0a0-0000-4000-8000-000000000001' },
  { kind: 'camera', id: 'a0a0a0a0-0000-4000-8000-000000000002' },
] as const;

const VIEWS: readonly HomeView[] = [
  { kind: 'home', checking: false },
  { kind: 'sensors', page: 0, checking: true },
  { kind: 'notifications' },
  { kind: 'notification-targets', page: 0, targets: TARGETS },
  { kind: 'notification-target', page: 0, target: TARGETS[0] },
  { kind: 'pause-duration' },
  { kind: 'pause-confirmation', hours: 4, receiptId: '1234567890abcdef' },
  { kind: 'more' },
  { kind: 'history' },
  { kind: 'admin-tools' },
  { kind: 'admin-sensor-setup' },
  { kind: 'admin-storage' },
  { kind: 'admin-system' },
  { kind: 'admin-cleanup-threshold' },
  { kind: 'confirmation', action: 'cleanup', receiptId: '1234567890abcdef' },
  { kind: 'cleanup-result', outcome: 'executed', threshold: 42 },
];

describe('Home view codec', () => {
  it('parses every supported canonical view shape', () => {
    for (const view of VIEWS) {
      const payload = view.kind === 'home' || view.kind === 'sensors' ? null : JSON.stringify(withoutKind(view));
      const parsed = parseHomeView(
        view.kind,
        view.kind === 'sensors' ? view.page : null,
        payload,
        view.kind === 'home' || view.kind === 'sensors' ? view.checking : null,
      );
      expect(parsed).toEqual(view);
    }
  });

  it('fails closed for non-canonical legacy columns and malformed payloads', () => {
    expect(parseHomeView('home', 1, null, false)).toBeNull();
    expect(parseHomeView('notifications', null, null, null)).toBeNull();
    expect(parseHomeView('notification-targets', null, JSON.stringify({ page: 1, targets: [TARGETS[0], TARGETS[0]] }), null)).toBeNull();
    expect(parseHomeView('notification-targets', null, JSON.stringify({ page: 1, targets: [...TARGETS, ...TARGETS, ...TARGETS, ...TARGETS, TARGETS[0]] }), null)).toBeNull();
    expect(parseHomeView('pause-confirmation', null, JSON.stringify({ hours: 2, receiptId: 'short' }), null)).toBeNull();
    expect(parseHomeView('cleanup-result', null, JSON.stringify({ outcome: 'executed', threshold: '42' }), null)).toBeNull();
    expect(parseHomeView('unknown', null, '{}', null)).toBeNull();
    expect(parseHomeView('more', null, `{"x":"${'a'.repeat(MAX_HOME_VIEW_PAYLOAD_BYTES)}"}`, null)).toBeNull();
  });

  it('uses zero-based pages consistently for persisted sensor and notification-target views', () => {
    expect(parseHomeView('sensors', 0, null, false)).toEqual({ kind: 'sensors', page: 0, checking: false });
    expect(parseHomeView('notification-targets', null, JSON.stringify({ page: 0, targets: TARGETS }), null))
      .toEqual({ kind: 'notification-targets', page: 0, targets: TARGETS });
    expect(parseHomeView('notification-target', null, JSON.stringify({ page: 0, target: TARGETS[0] }), null))
      .toEqual({ kind: 'notification-target', page: 0, target: TARGETS[0] });
  });

  it('encodes the cleanup threshold view with the canonical empty payload', () => {
    expect(encodeHomeView({ kind: 'admin-cleanup-threshold' })).toEqual({
      sensorPage: null,
      payload: '{}',
      checking: null,
    });
  });

  it.each([
    ['{ }', 'non-canonical JSON'],
    ['{} ', 'trailing whitespace'],
    ['{}\n', 'trailing newline'],
    ['{"unknown":true}', 'unknown key'],
  ])('rejects cleanup threshold payloads with %s', (payload) => {
    expect(parseHomeView('admin-cleanup-threshold', null, payload, null)).toBeNull();
  });

  it('bounds persisted payloads by UTF-8 bytes rather than JavaScript characters', () => {
    const payload = JSON.stringify({ unknown: 'é'.repeat(MAX_HOME_VIEW_PAYLOAD_BYTES / 2) });

    expect(payload.length).toBeLessThan(MAX_HOME_VIEW_PAYLOAD_BYTES);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(MAX_HOME_VIEW_PAYLOAD_BYTES);
    expect(parseHomeView('admin-cleanup-threshold', null, payload, null)).toBeNull();
  });
});

function withoutKind(view: HomeView): Record<string, unknown> {
  const { kind: _kind, ...payload } = view;
  return payload;
}
