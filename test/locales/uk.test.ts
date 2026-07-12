import { describe, expect, it } from 'vitest';
import { uk } from '../../src/locales/uk';

const date = new Date('2030-01-01T12:00:00Z');
const gdrive = (count: number) => uk.gdrive.body({
  usedBytes: 0,
  totalBytes: 0,
  lastUploadAt: null,
  pendingUploads: count,
  failedUploads: 0,
  lastError: null,
  cleanupMinAgeDays: count,
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

    expect(gdrive(1)).toContain('1 файл');
    expect(gdrive(2)).toContain('2 файли');
    expect(gdrive(5)).toContain('5 файлів');
    expect(gdrive(1)).toContain('1 день');
    expect(gdrive(2)).toContain('2 дні');
    expect(gdrive(5)).toContain('5 днів');
  });
});
