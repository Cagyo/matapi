import { describe, expect, it } from 'vitest';
import { uk } from '../../src/locales/uk';
import { en } from '../../src/locales/en';
import type { ArchiveDrainState } from '../../src/archive/application/use-cases/report-drive-status.use-case';

const date = new Date('2030-01-01T12:00:00Z');
const gdrive = (count: number, drainState: ArchiveDrainState = 'idle') => uk.gdrive.body({
  connection: null, account: null, folders: null,
  last: {
    refreshAtMs: null, uploadAtMs: null, backupAtMs: null,
    reconcileAtMs: null, cleanupAtMs: null,
    motionTraversalAtMs: null, artifactRegistrationAtMs: null,
  },
  artifacts: { pending: count }, attempts: { pending: count, missing: 0, detached: 0 },
  generations: [], quota: null, reclamation: null, requiredActions: [],
  queue: { queuedVideos: 0, retryableVideos: 0, oldestQueuedVideoAgeMs: null, unhealthyDateFolders: 0 },
  drainState,
});

describe('Ukrainian count-bearing formatters', () => {
  it('renders semantically correct 1, 2, and 5 variants', () => {
    expect(uk.status.footer(false, 1, date)).toContain('1 датчик не в мережі');
    expect(uk.status.footer(false, 2, date)).toContain('2 датчики не в мережі');
    expect(uk.status.footer(false, 5, date)).toContain('5 датчиків не в мережі');

    expect(uk.logs.header('door', 1)).toContain('останні 1');
    expect(uk.logs.header('door', 2)).toContain('останні 2');
    expect(uk.logs.header('door', 5)).toContain('останні 5');
    expect(uk.logs.debounceTriggered(1, 30)).toContain('1 подія');
    expect(uk.logs.debounceTriggered(2, 30)).toContain('2 події');
    expect(uk.logs.debounceTriggered(5, 30)).toContain('5 подій');

    expect(uk.menu.quietMode.activated(1)).toContain('1 годину');
    expect(uk.menu.quietMode.activated(2)).toContain('2 години');
    expect(uk.menu.quietMode.activated(5)).toContain('5 годин');
    expect(uk.mute.mutedAll(1)).toContain('1 датчика');
    expect(uk.mute.mutedAll(2)).toContain('2 датчиків');
    expect(uk.mute.mutedAll(5)).toContain('5 датчиків');
    expect(uk.mute.unmutedAll(1)).toContain('1 датчика');
    expect(uk.mute.unmutedAll(2)).toContain('2 датчиків');
    expect(uk.mute.unmutedAll(5)).toContain('5 датчиків');

    expect(uk.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', 1, false)).toContain('1 подію');
    expect(uk.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', 2, false)).toContain('2 події');
    expect(uk.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', 5, false)).toContain('5 подій');
    expect(uk.camera.browse.latestHeader(1)).toContain('1 подію');
    expect(uk.camera.browse.latestHeader(2)).toContain('2 події');
    expect(uk.camera.browse.latestHeader(5)).toContain('5 подій');
    expect(uk.camera.browse.duration(date, date, 1)).toBe('1 с');
    expect(uk.camera.browse.duration(date, date, 2)).toBe('2 с');
    expect(uk.camera.browse.duration(date, date, 5)).toBe('5 с');
    expect(uk.camera.eventsFooter(1)).toContain('1 подія');
    expect(uk.camera.eventsFooter(2)).toContain('2 події');
    expect(uk.camera.eventsFooter(5)).toContain('5 подій');

    expect(gdrive(1)).toContain('Артефактів: 1; спроб: 1');
    expect(gdrive(2)).toContain('Артефактів: 2; спроб: 2');
    expect(gdrive(5)).toContain('Артефактів: 5; спроб: 5');
  });

  it.each([
    ['active', 'активне завантаження'],
    ['idle', 'очікування'],
    ['cooling-down', 'пауза провайдера'],
    ['branch-blocked', 'гілку папок заблоковано'],
    ['quota-blocked', 'квоту вичерпано'],
    ['capacity-blocked', 'ліміт місткості'],
    ['policy-blocked', 'політику заблоковано'],
    ['reauthorization-required', 'потрібна повторна авторизація'],
  ] as const)('localizes the %s Drive drain state', (state, label) => {
    const rendered = gdrive(0, state);
    expect(rendered).toContain(`Стан черги: ${label}`);
    if (state !== label) expect(rendered).not.toContain(`Стан черги: ${state}`);
  });
});

describe('Ukrainian RTSP source copy', () => {
  it('translates the source workflow rather than echoing English', () => {
    expect(uk.camera.sources.dashboardButton).toBe('📡 RTSP-джерела');
    expect(uk.camera.sources.policy.scope).toBe('Лише локальна мережа');
    expect(uk.camera.sources.actions.back).toBe('« Назад');
    expect(uk.camera.sources.errors['authentication-failed'])
      .not.toBe(en.camera.sources.errors['authentication-failed']);
    expect(uk.camera.sources.prompts.credential)
      .not.toBe(en.camera.sources.prompts.credential);
  });

  it('pluralizes the credential-prompt expiry inside the privacy notice', () => {
    const networks = '• eth0 · 192.168.1.0/24 (IPv4)';
    expect(uk.camera.sources.privacyNotice({ networks, minutes: 1 })).toContain('1 хвилина');
    expect(uk.camera.sources.privacyNotice({ networks, minutes: 3 })).toContain('3 хвилини');
    expect(uk.camera.sources.privacyNotice({ networks, minutes: 10 })).toContain('10 хвилин');
  });
});
