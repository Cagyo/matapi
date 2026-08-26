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

describe('en.camera.sources', () => {
  it('opens on current status rather than a list of operations', () => {
    expect(en.camera.sources.dashboardButton).toBe('📡 RTSP Sources');
    expect(en.camera.sources.overview.title).toBe('📡 RTSP camera sources');
    expect(en.camera.sources.overview.page(2, 5)).toBe('Page 2 of 5');
    expect(en.camera.sources.policy.scope).toBe('Local network only');
    expect(en.camera.sources.policy.network({ interface: 'eth0', cidr: '192.168.1.0/24', family: 4 }))
      .toBe('• eth0 · 192.168.1.0/24 (IPv4)');
  });

  it('explains an empty library instead of showing an empty list', () => {
    expect(en.camera.sources.emptyState.title).toContain('No RTSP cameras');
    expect(en.camera.sources.emptyState.addFirst).toBe('➕ Add first camera');
  });

  it('renders a row and a detail without a camera identifier', () => {
    expect(en.camera.sources.row({ cameraName: 'Front door', status: en.camera.sources.statuses['configured-verified'] }))
      .toBe('Front door · ✅ Ready');
    // Pinned whole: the detail screen shows the host and never the camera
    // identifier, so an extra interpolated field fails here rather than in
    // review.
    expect(en.camera.sources.detail({
      cameraName: 'Front door',
      host: 'front-door.lan',
      status: en.camera.sources.statuses['needs-attention'],
      relationship: en.camera.sources.relationships.blocked,
    })).toBe([
      'Front door',
      'Address: front-door.lan',
      'Status: ⚠️ Needs attention',
      'Network: outside the camera network',
    ].join('\n'));
  });

  it('labels every declared recovery control', () => {
    expect(en.camera.sources.actions.back).toBe('« Back');
    expect(en.camera.sources.actions.retry).toBe('↻ Retry');
    expect(en.camera.sources.actions['change-address']).toBe('🔗 Change address');
    expect(en.camera.sources.actions['reinstall-rtsp']).toBe('🔁 Reinstall RTSP');
  });

  it('ends an exact-reply prompt with copy that names its own window', () => {
    expect(en.camera.sources.prompts.expired(10))
      .toBe('⏳ This camera setup expired after 10 minutes. Open RTSP Sources to start again.');
    expect(en.camera.sources.prompts.expired(1)).toContain('1 minute.');
    expect(en.camera.sources.prompts.cancelled).toBe('Camera setup cancelled. Nothing was changed.');
    expect(en.camera.sources.prompts.cancelButton).toBe('❌ Cancel');
  });

  it('reads every policy relationship as a fragment after `Network: `', () => {
    expect(en.camera.sources.relationships).toEqual({
      allowed: 'inside the camera network',
      blocked: 'outside the camera network',
      unresolved: 'at an address that does not resolve',
    });
  });

  it('warns before the credential prompt and names the ten-minute window', () => {
    const notice = en.camera.sources.privacyNotice({
      networks: '• eth0 · 192.168.1.0/24 (IPv4)',
      minutes: 10,
    });
    expect(notice).toContain('RTSP and strict RTSPS');
    expect(notice).toContain('may contain a username and password');
    expect(notice).toContain('Telegram has no secret channel');
    expect(notice).toContain('best effort');
    expect(notice).toContain('10 minutes');
  });

  it('identifies an undeleted credential reply by camera, never by content', () => {
    const warning = en.camera.sources.credentialDeletionFailed('Front door');
    expect(warning).toContain('Front door');
    expect(warning).toContain('delete it yourself');
    expect(warning).not.toMatch(/rtsps?:\/\//iu);
    /*
     * `deletionFailed` is set from a call that did not succeed, which is
     * indistinguishable from the message having already been gone — and it is
     * sticky, so it survives a later clean deletion. The copy therefore names
     * no culprit and promises no state: it asks the administrator to look.
     */
    expect(warning).not.toContain('Telegram');
    expect(warning).toMatch(/may not have been deleted/u);
  });
});
