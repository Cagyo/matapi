import { describe, expect, it } from 'vitest';
import {
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
  { kind: 'sensors', page: 2, checking: true },
  { kind: 'notifications' },
  { kind: 'notification-targets', page: 1, targets: TARGETS },
  { kind: 'notification-target', page: 1, target: TARGETS[0] },
  { kind: 'pause-duration' },
  { kind: 'pause-confirmation', hours: 4, receiptId: '1234567890abcdef' },
  { kind: 'more' },
  { kind: 'history' },
  { kind: 'admin-tools' },
  { kind: 'admin-sensor-setup' },
  { kind: 'admin-storage' },
  { kind: 'admin-system' },
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
    expect(parseHomeView('more', null, `{\"x\":\"${'a'.repeat(MAX_HOME_VIEW_PAYLOAD_BYTES)}\"}`, null)).toBeNull();
  });
});

function withoutKind(view: HomeView): Record<string, unknown> {
  const { kind: _kind, ...payload } = view;
  return payload;
}
