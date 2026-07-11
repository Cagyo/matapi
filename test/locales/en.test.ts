import { describe, expect, it } from 'vitest';
import { en, HealthSnapshotView, StatusRow } from '../../src/locales/en';

describe('en.status.line', () => {
  it('renders digital Closed for contact stepType', () => {
    const row: StatusRow = {
      name: 'front_door',
      type: 'digital',
      stepType: 'contact',
      lastValue: 'false',
      lastValueAt: new Date('2030-01-01T12:00:00Z'),
      online: true,
    };
    expect(en.status.line(row)).toContain('Closed');
    expect(en.status.line(row)).not.toContain('since');
  });

  it('renders digital Opened with `since` for contact stepType', () => {
    const row: StatusRow = {
      name: 'front_door',
      type: 'digital',
      stepType: 'contact',
      lastValue: 'true',
      lastValueAt: new Date('2030-01-01T14:23:00Z'),
      online: true,
    };
    expect(en.status.line(row)).toContain('Opened');
    expect(en.status.line(row)).toMatch(/since \d{2}:\d{2}/);
  });

  it('renders digital Leak Detected for leak_hazard stepType', () => {
    const row: StatusRow = {
      name: 'basement_leak',
      type: 'digital',
      stepType: 'leak_hazard',
      lastValue: 'true',
      lastValueAt: new Date('2030-01-01T14:23:00Z'),
      online: true,
    };
    expect(en.status.line(row)).toContain('Leak Detected');
  });

  it('renders uart with critical marker', () => {
    const row: StatusRow = {
      name: 'co2',
      type: 'uart',
      lastValue: '1500',
      lastValueAt: new Date(),
      online: true,
      thresholdLevel: 'critical',
    };
    const line = en.status.line(row);
    expect(line).toContain('1500 ppm');
    expect(line).toContain('❌');
  });

  it('marks offline regardless of value', () => {
    const row: StatusRow = {
      name: 'co2',
      type: 'uart',
      lastValue: '600',
      lastValueAt: new Date(),
      online: false,
    };
    expect(en.status.line(row)).toContain('offline');
  });
});

describe('en.status.footer', () => {
  const now = new Date('2030-01-01T12:00:00Z');

  it('reports all online', () => {
    expect(en.status.footer(true, 0, now)).toMatch(/All systems online/);
  });

  it('reports single offline (singular)', () => {
    expect(en.status.footer(false, 1, now)).toMatch(/1 sensor offline/);
  });

  it('pluralises offline count', () => {
    expect(en.status.footer(false, 3, now)).toMatch(/3 sensors offline/);
  });
});

describe('en.health.body', () => {
  it('renders every metric line', () => {
    const snap: HealthSnapshotView = {
      diskUsedBytes: 12 * 1024 ** 3,
      diskTotalBytes: 30 * 1024 ** 3,
      cpuTempC: 52.3,
      memoryUsedBytes: 300 * 1024 ** 2,
      memoryTotalBytes: 1024 ** 3,
      uptimeSec: 14 * 86400 + 6 * 3600 + 23 * 60,
      dbSizeBytes: 4 * 1024 ** 2,
      botLastUpdateAgoSec: 12,
      sensorsOnline: 4,
      sensorsTotal: 5,
    };
    const body = en.health.body(snap);
    expect(body).toContain('Disk: 12.0 GB / 30.0 GB');
    expect(body).toContain('CPU Temp: 52°C');
    expect(body).toContain('14d 6h 23m');
    expect(body).toContain('4/5 online');
    expect(body).toContain('last update 12s ago');
  });

  it('shows N/A when fields are unavailable', () => {
    const snap: HealthSnapshotView = {
      diskUsedBytes: null,
      diskTotalBytes: null,
      cpuTempC: null,
      memoryUsedBytes: 0,
      memoryTotalBytes: 0,
      uptimeSec: 0,
      dbSizeBytes: null,
      botLastUpdateAgoSec: null,
      sensorsOnline: 0,
      sensorsTotal: 0,
    };
    const body = en.health.body(snap);
    expect(body).toContain('N/A');
    expect(body).toContain('idle');
  });
});

describe('en navigation grammar', () => {
  it('uses the shared cancel label in system update and config import', () => {
    expect(en.systemUpdate.cancelButton).toBe('❌ Cancel');
    expect(en.importConfig.cancelButton).toBe('❌ Cancel');
  });
});
