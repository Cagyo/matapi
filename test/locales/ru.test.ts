import { describe, expect, it } from 'vitest';
import { ru } from '../../src/locales/ru';

const values = [1, 2, 5];

describe('Russian plural formatters', () => {
  it('renders 1, 2, and 5 for every count-bearing formatter', () => {
    const outputs = values.flatMap((count) => [
      ru.status.footer(false, count, new Date('2030-01-01T12:00:00Z')),
      ru.logs.header('door', count),
      ru.logs.debounceTriggered(count, 30),
      ru.menu.quietMode.activated(count),
      ru.mute.mutedAll(count),
      ru.mute.unmutedAll(count),
      ru.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', count, false),
      ru.camera.browse.latestHeader(count),
      ru.camera.browse.duration(new Date(), new Date(), count),
      ru.camera.eventsFooter(count),
      ru.gdrive.body({
        usedBytes: 0,
        totalBytes: 0,
        lastUploadAt: null,
        pendingUploads: count,
        failedUploads: 0,
        lastError: null,
        cleanupMinAgeDays: count,
      }),
    ]);
    expect(outputs).toHaveLength(33);
    expect(ru.status.footer(false, 1, new Date())).toContain('1 датчик не в сети');
    expect(ru.status.footer(false, 2, new Date())).toContain('2 датчика не в сети');
    expect(ru.status.footer(false, 5, new Date())).toContain('5 датчиков не в сети');
    expect(ru.logs.debounceTriggered(1, 30)).toContain('1 событие');
    expect(ru.logs.debounceTriggered(2, 30)).toContain('2 события');
    expect(ru.logs.debounceTriggered(5, 30)).toContain('5 событий');
    expect(ru.camera.browse.duration(new Date(), new Date(), 1)).toBe('1 с');
    expect(ru.camera.browse.duration(new Date(), new Date(), 2)).toBe('2 с');
    expect(ru.camera.browse.duration(new Date(), new Date(), 5)).toBe('5 с');
    expect(ru.gdrive.body({ usedBytes: 0, totalBytes: 0, lastUploadAt: null, pendingUploads: 1, failedUploads: 0, lastError: null, cleanupMinAgeDays: 1 })).toContain('1 день');
    expect(ru.gdrive.body({ usedBytes: 0, totalBytes: 0, lastUploadAt: null, pendingUploads: 2, failedUploads: 0, lastError: null, cleanupMinAgeDays: 2 })).toContain('2 дня');
    expect(ru.gdrive.body({ usedBytes: 0, totalBytes: 0, lastUploadAt: null, pendingUploads: 5, failedUploads: 0, lastError: null, cleanupMinAgeDays: 5 })).toContain('5 дней');
  });
});
