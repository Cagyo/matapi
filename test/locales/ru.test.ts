import { describe, expect, it } from 'vitest';
import { ru } from '../../src/locales/ru';
import { en } from '../../src/locales/en';
import type { ArchiveDrainState } from '../../src/archive/application/use-cases/report-drive-status.use-case';

const date = new Date('2030-01-01T12:00:00Z');
const gdrive = (count: number, drainState: ArchiveDrainState = 'idle') => ru.gdrive.body({
  connection: null, account: null, folders: null,
  last: {
    refreshAtMs: null, uploadAtMs: null, backupAtMs: null,
    reconcileAtMs: null, cleanupAtMs: null,
    motionTraversalAtMs: null, artifactRegistrationAtMs: null,
  },
  artifacts: { pending: count }, attempts: { pending: count, missing: 0, detached: 0 },
  generations: [], quota: null, reclamation: null, requiredAction: null,
  queue: { queuedVideos: 0, retryableVideos: 0, oldestQueuedVideoAgeMs: null, unhealthyDateFolders: 0 },
  drainState,
});

describe('Russian count-bearing formatters', () => {
  it('renders semantically correct 1, 2, and 5 variants', () => {
    expect(ru.status.footer(false, 1, date)).toContain('1 датчик не в сети');
    expect(ru.status.footer(false, 2, date)).toContain('2 датчика не в сети');
    expect(ru.status.footer(false, 5, date)).toContain('5 датчиков не в сети');

    expect(ru.logs.header('door', 1)).toContain('последние 1');
    expect(ru.logs.header('door', 2)).toContain('последние 2');
    expect(ru.logs.header('door', 5)).toContain('последние 5');
    expect(ru.logs.debounceTriggered(1, 30)).toContain('1 событие');
    expect(ru.logs.debounceTriggered(2, 30)).toContain('2 события');
    expect(ru.logs.debounceTriggered(5, 30)).toContain('5 событий');

    expect(ru.menu.quietMode.activated(1)).toContain('1 час');
    expect(ru.menu.quietMode.activated(2)).toContain('2 часа');
    expect(ru.menu.quietMode.activated(5)).toContain('5 часов');
    expect(ru.mute.mutedAll(1)).toContain('1 датчика');
    expect(ru.mute.mutedAll(2)).toContain('2 датчиков');
    expect(ru.mute.mutedAll(5)).toContain('5 датчиков');
    expect(ru.mute.unmutedAll(1)).toContain('1 датчика');
    expect(ru.mute.unmutedAll(2)).toContain('2 датчиков');
    expect(ru.mute.unmutedAll(5)).toContain('5 датчиков');

    expect(ru.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', 1, false)).toContain('1 событие');
    expect(ru.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', 2, false)).toContain('2 события');
    expect(ru.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', 5, false)).toContain('5 событий');
    expect(ru.camera.browse.latestHeader(1)).toContain('1 событие');
    expect(ru.camera.browse.latestHeader(2)).toContain('2 события');
    expect(ru.camera.browse.latestHeader(5)).toContain('5 событий');
    expect(ru.camera.browse.duration(date, date, 1)).toBe('1 с');
    expect(ru.camera.browse.duration(date, date, 2)).toBe('2 с');
    expect(ru.camera.browse.duration(date, date, 5)).toBe('5 с');
    expect(ru.camera.eventsFooter(1)).toContain('1 событие');
    expect(ru.camera.eventsFooter(2)).toContain('2 события');
    expect(ru.camera.eventsFooter(5)).toContain('5 событий');

    expect(gdrive(1)).toContain('Артефактов: 1; попыток: 1');
    expect(gdrive(2)).toContain('Артефактов: 2; попыток: 2');
    expect(gdrive(5)).toContain('Артефактов: 5; попыток: 5');
  });

  it.each([
    ['active', 'активная загрузка'],
    ['idle', 'ожидание'],
    ['cooling-down', 'пауза провайдера'],
    ['branch-blocked', 'ветка папок заблокирована'],
    ['quota-blocked', 'квота исчерпана'],
    ['capacity-blocked', 'лимит ёмкости'],
    ['policy-blocked', 'политика заблокирована'],
    ['clock-blocked', 'системные часы заблокированы'],
    ['reauthorization-required', 'требуется повторная авторизация'],
  ] as const)('localizes the %s Drive drain state', (state, label) => {
    const rendered = gdrive(0, state);
    expect(rendered).toContain(`Состояние очереди: ${label}`);
    if (state !== label) expect(rendered).not.toContain(`Состояние очереди: ${state}`);
  });
});

describe('Russian RTSP source copy', () => {
  it('translates the source workflow rather than echoing English', () => {
    expect(ru.camera.sources.dashboardButton).toBe('📡 RTSP-источники');
    expect(ru.camera.sources.policy.scope).toBe('Только локальная сеть');
    expect(ru.camera.sources.actions.back).toBe('« Назад');
    expect(ru.camera.sources.errors['authentication-failed'])
      .not.toBe(en.camera.sources.errors['authentication-failed']);
    expect(ru.camera.sources.prompts.credential)
      .not.toBe(en.camera.sources.prompts.credential);
  });

  it('pluralizes the credential-prompt expiry inside the privacy notice', () => {
    const networks = '• eth0 · 192.168.1.0/24 (IPv4)';
    expect(ru.camera.sources.privacyNotice({ networks, minutes: 1 })).toContain('1 минута');
    expect(ru.camera.sources.privacyNotice({ networks, minutes: 3 })).toContain('3 минуты');
    expect(ru.camera.sources.privacyNotice({ networks, minutes: 10 })).toContain('10 минут');
  });
});
