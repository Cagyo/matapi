import { describe, expect, it } from 'vitest';
import { uk } from '../../src/locales/uk';

const values = [1, 2, 5];

describe('Ukrainian plural formatters', () => {
  it('renders 1, 2, and 5 for every count-bearing formatter', () => {
    const outputs = values.flatMap((count) => [
      uk.status.footer(false, count, new Date('2030-01-01T12:00:00Z')),
      uk.logs.header('door', count),
      uk.logs.debounceTriggered(count, 30),
      uk.menu.quietMode.activated(count),
      uk.mute.mutedAll(count),
      uk.mute.unmutedAll(count),
      uk.camera.browse.rangeHeader('01.01.2030', '10:00-11:00', count, false),
      uk.camera.browse.latestHeader(count),
      uk.camera.browse.duration(new Date(), new Date(), count),
      uk.camera.eventsFooter(count),
      uk.gdrive.body({
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
    expect(uk.status.footer(false, 1, new Date())).toContain('1 датчик не в мережі');
    expect(uk.status.footer(false, 2, new Date())).toContain('2 датчики не в мережі');
    expect(uk.status.footer(false, 5, new Date())).toContain('5 датчиків не в мережі');
    expect(uk.logs.debounceTriggered(1, 30)).toContain('1 подія');
    expect(uk.logs.debounceTriggered(2, 30)).toContain('2 події');
    expect(uk.logs.debounceTriggered(5, 30)).toContain('5 подій');
    expect(uk.camera.browse.duration(new Date(), new Date(), 1)).toBe('1 с');
    expect(uk.camera.browse.duration(new Date(), new Date(), 2)).toBe('2 с');
    expect(uk.camera.browse.duration(new Date(), new Date(), 5)).toBe('5 с');
    expect(uk.gdrive.body({ usedBytes: 0, totalBytes: 0, lastUploadAt: null, pendingUploads: 1, failedUploads: 0, lastError: null, cleanupMinAgeDays: 1 })).toContain('1 день');
    expect(uk.gdrive.body({ usedBytes: 0, totalBytes: 0, lastUploadAt: null, pendingUploads: 2, failedUploads: 0, lastError: null, cleanupMinAgeDays: 2 })).toContain('2 дні');
    expect(uk.gdrive.body({ usedBytes: 0, totalBytes: 0, lastUploadAt: null, pendingUploads: 5, failedUploads: 0, lastError: null, cleanupMinAgeDays: 5 })).toContain('5 днів');
  });
});
