import { describe, expect, it } from 'vitest';
import { en } from '../../src/locales/en';

describe('en.camera', () => {
  it('renders the snapshot caption', () => {
    const at = new Date('2026-04-08T14:35:00');
    expect(en.camera.snapshotCaption('front_door', at)).toBe(
      '📸 front_door | 08.04.2026 14:35',
    );
  });

  it('renders an event line with duration and snapshot marker', () => {
    const line = en.camera.eventLine({
      id: 42,
      startedAt: new Date('2026-04-08T12:51:06'),
      durationSec: 30,
      hasSnapshot: true,
    });
    expect(line).toBe('#42 — 12:51:06 (30s) 📷');
  });

  it('omits duration and marker when absent', () => {
    const line = en.camera.eventLine({
      id: 7,
      startedAt: null,
      durationSec: null,
      hasSnapshot: false,
    });
    expect(line).toBe('#7 — --:--:--');
  });

  it('renders the status body', () => {
    const body = en.camera.statusBody({
      running: true,
      lastEventAt: new Date('2026-04-08T15:22:00'),
      localStorageBytes: 847 * 1024 ** 2,
      eventsToday: 12,
    });
    expect(body).toContain('Motion: ✅ Running');
    expect(body).toContain('Local storage: 847 MB');
    expect(body).toContain('Events today: 12');
  });

  it('pluralises the events footer', () => {
    expect(en.camera.eventsFooter(1)).toContain('1 event.');
    expect(en.camera.eventsFooter(3)).toContain('3 events.');
  });

  it('renders Browse Events dashboard and menu copy', () => {
    expect(en.camera.dashboardTitle).toBe('📹 Camera Dashboard\nSelect an action:');
    expect(en.camera.dashboardButtons.browseEvents).toBe('📹 Browse Events');
    expect(en.camera.browse.menuTitle).toContain('📹 Browse Motion Events');
    expect(en.camera.browse.menuTitle).toContain(
      'Pick date will ask for a time range',
    );
  });

  it('renders Browse Events prompts and validation messages', () => {
    expect(en.camera.browse.datePrompt).toContain('Format: DD.MM.YYYY');
    expect(en.camera.browse.timeRangePrompt('today')).toContain(
      'Send the time range for today.',
    );
    expect(en.camera.browse.timeRangePrompt('08.04.2026')).toContain(
      'Send the time range for 08.04.2026.',
    );
    expect(en.camera.browse.invalidDate).toContain(
      'Date needs to be DD.MM.YYYY',
    );
    expect(en.camera.browse.invalidTimeRange).toContain(
      'Time range needs to be HH:MM-HH:MM',
    );
    expect(en.camera.browse.invalidTimeOrder).toContain(
      'Overnight ranges are not supported yet',
    );
  });

  it('renders Browse Events headers, event lines, and compact buttons', () => {
    expect(
      en.camera.browse.rangeHeader('08.04.2026', '18:00-23:00', 12, false),
    ).toBe('📹 Events for 08.04.2026, 18:00-23:00\nNewest first. Showing 12 events.');
    expect(
      en.camera.browse.rangeHeader('08.04.2026', '18:00-23:00', 20, true),
    ).toContain('Showing the newest 20 matches');
    expect(en.camera.browse.latestHeader(20)).toBe(
      '📹 Latest Motion Events\nNewest first. Showing 20 events.',
    );
    expect(
      en.camera.browse.eventLine({
        id: 42,
        startedAt: new Date('2026-04-08T12:51:06'),
        camera: 'front_door',
        duration: '30s',
        media: 'Video + Photo',
      }),
    ).toBe('#42 12:51 - front_door - 30s - Video + Photo');
    expect(
      en.camera.browse.eventButton({
        id: 42,
        startedAt: new Date('2026-04-08T12:51:06'),
        camera: 'front_door_camera_with_long_name',
        duration: '30s',
      }),
    ).toBe('12:51 | #42 | 30s | front_door_came…');
    expect(en.camera.browse.duration(null, null, null)).toBe('unknown');
    expect(
      en.camera.browse.duration(new Date('2026-04-08T12:51:06'), null, null),
    ).toBe('recording');
    expect(
      en.camera.browse.duration(
        new Date('2026-04-08T12:51:06'),
        new Date('2026-04-08T12:51:36'),
        30,
      ),
    ).toBe('30s');
    expect(
      en.camera.browse.media({
        hasLocalVideo: true,
        hasDriveVideo: false,
        hasPhoto: true,
      }),
    ).toBe('Video + Photo');
    expect(
      en.camera.browse.media({
        hasLocalVideo: false,
        hasDriveVideo: true,
        hasPhoto: false,
      }),
    ).toBe('Video archived on Drive');
  });

  it('renders Browse Events action screen and empty states', () => {
    expect(en.camera.browse.emptyRange('08.04.2026', '18:00-23:00')).toContain(
      'No motion events found for 08.04.2026, 18:00-23:00.',
    );
    expect(en.camera.browse.emptyLatest).toBe('No motion events recorded yet.');
    expect(
      en.camera.browse.actionHeader({
        id: 42,
        startedAt: new Date('2026-04-08T12:51:06'),
        camera: 'front_door',
        duration: '30s',
        media: 'Video + Photo',
      }),
    ).toContain('Media: Video + Photo');
    expect(en.camera.browse.resultsExpired).toContain('expired');
    expect(en.camera.browse.expiredInput).toContain('expired');
  });
});

describe('en.gdrive', () => {
  const base = {
    usedBytes: 8.2 * 1024 ** 3,
    totalBytes: 15 * 1024 ** 3,
    lastUploadAt: new Date('2026-04-08T15:30:00'),
    pendingUploads: 3,
    failedUploads: 0,
    lastError: null,
    cleanupMinAgeDays: 30,
  };

  it('renders a healthy status body', () => {
    const body = en.gdrive.body(base);
    expect(body).toContain('📦 Used: 8.2 GB / 15.0 GB (55%)');
    expect(body).toContain('📋 Pending uploads: 3 files');
    expect(body).toContain('⚠️ Failed uploads: 0');
    expect(body).toContain('🗑️ Auto-cleanup: active (min age: 30 days)');
    expect(body).not.toContain('🚨');
  });

  it('adds an unhealthy banner past the failure threshold', () => {
    const body = en.gdrive.body({
      ...base,
      failedUploads: 5,
      lastError: 'auth token expired',
    });
    expect(body).toContain('⚠️ Failed uploads: 5 (last error: auth token expired)');
    expect(body).toContain('🚨 Sync unhealthy — 5 consecutive failures');
  });
});

describe('en.gdriveAuth', () => {
  it('shows the SSH command for configuring rclone on the Pi', () => {
    expect(en.gdriveAuth.prompt).toContain('ssh pi@<pi-host>');
    expect(en.gdriveAuth.prompt).toContain(
      'sudo -H -u homeworker env RCLONE_CONFIG=/home/homeworker/.config/rclone/rclone.conf rclone config',
    );
    expect(en.gdriveAuth.prompt).toContain('rclone authorize "drive"');
  });
});
