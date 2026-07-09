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
