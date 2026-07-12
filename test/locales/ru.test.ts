import { describe, expect, it } from 'vitest';
import { ru } from '../../src/locales/ru';

const date = new Date('2030-01-01T12:00:00Z');
const gdrive = (count: number) => ru.gdrive.body({
  usedBytes: 0,
  totalBytes: 0,
  lastUploadAt: null,
  pendingUploads: count,
  failedUploads: 0,
  lastError: null,
  cleanupMinAgeDays: count,
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

    expect(gdrive(1)).toContain('1 файл');
    expect(gdrive(2)).toContain('2 файла');
    expect(gdrive(5)).toContain('5 файлов');
    expect(gdrive(1)).toContain('1 день');
    expect(gdrive(2)).toContain('2 дня');
    expect(gdrive(5)).toContain('5 дней');
  });
});
