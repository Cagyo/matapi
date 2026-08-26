import { describe, expect, it } from 'vitest';
import { catalogFor, catalogs } from '../../src/locales/catalog';
import {
  CAMERA_SOURCE_FAILURE_KINDS,
  CAMERA_SOURCE_RECOVERY_ACTIONS,
} from '../../src/telegram/interfaces/camera-source-error.presenter';
import { en } from '../../src/locales/en';
import { ru } from '../../src/locales/ru';
import { uk } from '../../src/locales/uk';

describe('en.camera', () => {
  it('provides synchronized experimental live-stream copy', () => {
    for (const catalog of [en, ru, uk]) {
      expect(catalog.camera.live).toMatchObject({
        experimentalLabel: expect.any(String),
        opening: expect.any(String),
        watchButton: expect.any(String),
        unavailable: expect.any(String),
        sourceUnavailable: expect.any(String),
        stopped: expect.any(String),
        noActive: expect.any(String),
        expired: expect.any(String),
        adminFailure: expect.any(String),
      });
      expect(catalog.camera.live.opened(5)).toContain('5');
    }
  });

  // The ru/uk strings are required by the LocaleCatalog shape, not reached at
  // runtime: TelegramAdminAlertAdapter hardcodes `en` for every camera alert
  // kind. This is catalogue hygiene, not proof of a localized delivery path.
  it('renders the motion scan admin alert in every locale', () => {
    for (const catalog of [en, ru, uk]) {
      const rendered = catalog.camera.adminAlert.motionScanFailing('motion_fs_access_denied');
      expect(rendered).toContain('motion_fs_access_denied');
      expect(rendered).toContain('Motion');
      expect(rendered).not.toContain('/');
    }
    expect(ru.camera.adminAlert.motionScanFailing('motion_fs_io_failure'))
      .not.toBe(en.camera.adminAlert.motionScanFailing('motion_fs_io_failure'));
    expect(uk.camera.adminAlert.motionScanFailing('motion_fs_io_failure'))
      .not.toBe(ru.camera.adminAlert.motionScanFailing('motion_fs_io_failure'));
  });

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
    connection: { generationId: 'g1', state: 'active', errorCode: null },
    account: { permissionId: 'perm-1', email: null, displayName: null },
    folders: null,
    last: { refreshAtMs: null, uploadAtMs: new Date('2026-04-08T15:30:00').getTime(), backupAtMs: null, reconcileAtMs: null, cleanupAtMs: null },
    artifacts: { pending: 3 },
    attempts: { pending: 3, missing: 0, detached: 0 },
    generations: [],
    quota: { usageBytes: 8.2 * 1024 ** 3, limitBytes: 15 * 1024 ** 3, usageInDriveBytes: 8 * 1024 ** 3, usageInDriveTrashBytes: .2 * 1024 ** 3 },
    reclamation: null,
    requiredActions: [],
  };

  it('renders a healthy status body', () => {
    const body = en.gdrive.body(base);
    expect(body).toContain('📦 Used: 8.2 GB / 15.0 GB (55%)');
    expect(body).toContain('Connection: active');
    expect(body).toContain('Account permission: perm-1');
    expect(body).toContain('📋 Artifacts: 3; attempts: 3');
    expect(body).not.toContain('🚨');
  });

  it('renders private folder links and required actions only in the admin status view', () => {
    const body = en.gdrive.body({
      ...base,
      folders: { root: 'https://drive.google.com/root', motion: 'https://drive.google.com/motion', backups: 'https://drive.google.com/backups' },
      requiredActions: ['reauthorize', 'manual-cleanup'],
    });
    expect(body).toContain('Private folders:');
    expect(body).toContain('reauthorize');
  });
});

/*
 * `camera.sources` is the one catalog section with no English fallback: the
 * RTSP workflow prompts for a URL that carries a camera password, and an
 * administrator who cannot read the warning cannot consent to it. So parity
 * here is checked structurally (keys and value kinds) *and* by identity — a
 * Russian lookup that resolves to the English object would satisfy every shape
 * assertion ever written.
 */
describe('camera.sources catalog', () => {
  const LOCALES = [['ru', ru], ['uk', uk]] as const;

  function shape(value: unknown): unknown {
    if (typeof value === 'function') return 'function';
    // Element kinds, not length: a cancellation-synonym list legitimately
    // has a different number of words per language.
    if (Array.isArray(value)) return `array<${[...new Set(value.map(shape))].sort().join('|')}>`;
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]),
      );
    }
    return typeof value;
  }

  /*
   * Every string leaf, path-tagged.
   *
   * `intoArrays` is off for the per-key identity comparison, because a
   * cancellation-synonym list legitimately holds a different number of words
   * per language and its first entry is deliberately the same Latin word
   * everywhere — comparing `cancelSynonyms[0]` across locales would fail on
   * copy that is correct. It is on for the leak scan, whose whole claim is
   * that *every* source string is clean.
   */
  function stringLeaves(value: unknown, path = '', intoArrays = false): [string, string][] {
    if (typeof value === 'string') return [[path, value]];
    if (Array.isArray(value)) {
      return intoArrays
        ? value.flatMap((item, index) => stringLeaves(item, `${path}[${index}]`, true))
        : [];
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, child]) =>
        stringLeaves(child, path ? `${path}.${key}` : key, intoArrays),
      );
    }
    return [];
  }

  it('is present in every locale, not an optional English fallback', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.camera.sources).toEqual(expect.any(Object));
      expect(Object.keys(catalog.camera.sources).length).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('keeps every %s source key and value kind identical to English', (_locale, catalog) => {
    expect(shape(catalog.camera.sources)).toEqual(shape(en.camera.sources));
  });

  it.each(LOCALES)('never resolves a %s source lookup to the English object', (locale, catalog) => {
    expect(catalog.camera.sources).not.toBe(en.camera.sources);
    expect(catalogFor(locale).camera.sources).not.toBe(en.camera.sources);

    const translated = stringLeaves(catalog.camera.sources);
    const english = new Map(stringLeaves(en.camera.sources));
    expect(translated.length).toBeGreaterThan(40);
    for (const [path, value] of translated) {
      expect(value, `${locale}: ${path}`).not.toBe(english.get(path));
    }
    expect(catalog.camera.sources.cancelSynonyms).not.toEqual(en.camera.sources.cancelSynonyms);
  });

  it('names every failure kind and every recovery action in every locale', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      const { errors, actions } = catalog.camera.sources;
      expect(Object.keys(errors).sort(), locale).toEqual([...CAMERA_SOURCE_FAILURE_KINDS].sort());
      expect(Object.keys(actions).sort(), locale).toEqual([...CAMERA_SOURCE_RECOVERY_ACTIONS].sort());
      for (const kind of CAMERA_SOURCE_FAILURE_KINDS) {
        expect(errors[kind].length, `${locale}/${kind}`).toBeGreaterThan(0);
      }
      for (const action of CAMERA_SOURCE_RECOVERY_ACTIONS) {
        expect(actions[action].length, `${locale}/${action}`).toBeGreaterThan(0);
      }
    }
  });

  it('names every operational state and policy relationship in every locale', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      expect(Object.keys(catalog.camera.sources.statuses).sort(), locale)
        .toEqual(['configured-verified', 'credentials-required', 'needs-attention', 'not-ready']);
      expect(Object.keys(catalog.camera.sources.relationships).sort(), locale)
        .toEqual(['allowed', 'blocked', 'unresolved']);
      expect(Object.keys(catalog.camera.sources.policy.state).sort(), locale)
        .toEqual(['ready', 'stale', 'unavailable']);
    }
  });

  /*
   * Task 5 sends this before the credential ForceReply, and it is the only
   * place the administrator is told what they are about to hand Telegram.
   * Every clause below is a separate promise, so each is asserted separately.
   */
  it('states accepted schemes, networks, credentials, Telegram, best effort and expiry in every locale', () => {
    const networks = '• eth0 · 192.168.1.0/24 (IPv4)';
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      const notice = catalog.camera.sources.privacyNotice({ networks, minutes: 10 });
      expect(notice, locale).toContain('RTSP');
      expect(notice, locale).toContain('RTSPS');
      expect(notice, locale).toContain(networks);
      expect(notice, locale).toContain('Telegram');
      expect(notice, locale).toContain('10');
      // Six distinct clauses, so a translation that dropped one is visible.
      expect(notice.split('\n').filter((line) => line.trim().length > 0).length, locale)
        .toBeGreaterThanOrEqual(6);
    }
    expect(en.camera.sources.privacyNotice({ networks, minutes: 10 }).toLowerCase())
      .toContain('best effort');
  });

  it('offers both removal readings, camera and source, in every locale', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      const removal = catalog.camera.sources.removal;
      expect(removal.confirmCamera('Front door'), locale).toContain('Front door');
      expect(removal.confirmSource('Front door'), locale).toContain('Front door');
      expect(removal.confirmCamera('Front door'), locale).not.toBe(removal.confirmSource('Front door'));
      expect(removal.removeCameraButton, locale).not.toBe(removal.removeSourceButton);
    }
    expect(en.camera.sources.removal.removeCameraButton).toContain('camera');
    expect(en.camera.sources.removal.removeSourceButton).toContain('source');
  });

  /*
   * Task 7 renders all three of these: the expiry message on a late or
   * boundary reply, the acknowledgement after an authoritative callback
   * Cancel, and the Cancel control itself. They live beside the prompts they
   * end rather than in `actions`, which is scoped to failure-screen controls.
   */
  it('carries the prompt lifecycle copy in every locale, with the window as a parameter', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      const { expired, cancelled, cancelButton } = catalog.camera.sources.prompts;

      expect(expired(10), locale).toContain('10');
      expect(expired(1), locale).toContain('1');
      // The window is interpolated, never spelled in prose: a changed TTL must
      // change the message in all three languages without a translation edit.
      expect(expired(7), locale).toContain('7');
      expect(expired(7), locale).not.toBe(expired(10));
      expect(cancelled.length, locale).toBeGreaterThan(0);
      expect(cancelButton.length, locale).toBeGreaterThan(0);
    }
  });

  /*
   * `relationships` is a closed record, so all three values are contractually
   * interchangeable in one slot — `detail`'s `Network: …` line and the last
   * line of `details.body`. A value that is a full clause rather than a
   * fragment reads as a grammar error in exactly that slot.
   */
  it('keeps every policy relationship a fragment that fits one rendered slot', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      for (const [key, value] of Object.entries(catalog.camera.sources.relationships)) {
        expect(value, `${locale}/${key}`).not.toMatch(/[.!?]$/u);
        expect(value.slice(0, 1), `${locale}/${key}`).toBe(value.slice(0, 1).toLowerCase());
        expect(catalog.camera.sources.detail({
          cameraName: 'Front door',
          host: 'front-door.lan',
          status: catalog.camera.sources.statuses['needs-attention'],
          relationship: value,
        }), `${locale}/${key}`).toContain(value);
      }
    }
  });

  it('lists cancellation synonyms already normalized for exact comparison', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      const synonyms = catalog.camera.sources.cancelSynonyms;
      expect(synonyms.length, locale).toBeGreaterThan(0);
      expect(new Set(synonyms).size, locale).toBe(synonyms.length);
      for (const synonym of synonyms) {
        expect(synonym, locale).toBe(synonym.trim().toLowerCase());
        expect(synonym.length, locale).toBeGreaterThan(0);
        /*
         * Normalized form too, not just case and whitespace. A decomposed
         * Cyrillic word is visually identical to its composed twin and passes
         * both checks above, but a phone keyboard emits NFC — so an NFD entry
         * would be a dead synonym that nothing could ever match, and nothing
         * else in this suite can see it.
         */
        expect(synonym, locale).toBe(synonym.normalize('NFC'));
      }
    }
    // The Latin word stays accepted everywhere: an administrator on a phone
    // keyboard that is not set to the interface language still needs a way out.
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      expect(catalog.camera.sources.cancelSynonyms, locale).toContain('cancel');
    }
  });

  /*
   * The catalog is the last place a credential could be hard-coded into a
   * message that reaches a chat. Nothing here may look like an address.
   */
  it('keeps every source string free of a URL, credential or camera identifier', () => {
    for (const [locale, catalog] of [['en', en], ...LOCALES] as const) {
      const leaves = stringLeaves(catalog.camera.sources, '', true);
      // Proof the array elements are actually in scope: without recursion the
      // synonym entries below would silently not be scanned at all.
      expect(leaves.map(([path]) => path), locale).toContain('cancelSynonyms[0]');
      for (const [path, value] of leaves) {
        expect(value, `${locale}: ${path}`).not.toMatch(/rtsps?:\/\//iu);
        expect(value, `${locale}: ${path}`).not.toMatch(/@/u);
        expect(value, `${locale}: ${path}`).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/u);
      }
    }
  });
});
