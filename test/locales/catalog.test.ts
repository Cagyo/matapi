import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { catalogs, catalogFor } from '../../src/locales/catalog';
import { en } from '../../src/locales/en';

describe('catalogFor', () => {
  it('returns English for English and invalid locale values', () => {
    expect(catalogFor('en')).toBe(en);
    expect(catalogFor('invalid')).toBe(en);
  });

  it('selects translated command and status formatters', () => {
    expect(catalogFor('ru').commands.find((c) => c.command === 'settings')?.description)
      .not.toBe(en.commands.find((c) => c.command === 'settings')?.description);
    expect(catalogFor('uk').status.footer(false, 2, new Date('2030-01-01T12:00:00Z')))
      .not.toContain('sensors offline');
  });

  it('deeply freezes catalogs and their registry', () => {
    expect(Object.isFrozen(catalogs)).toBe(true);
    expect(Object.isFrozen(en)).toBe(true);
    expect(Object.isFrozen(en.commands)).toBe(true);
    expect(Object.isFrozen(en.sensors.steps.contact)).toBe(true);
  });

  it('keeps config state labels and event time formatting in frozen presentation data', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.presentation.config.sensorTypes.digital).toBeTruthy();
      expect(catalog.presentation.config.severities.critical).toBeTruthy();
      expect(catalog.presentation.config.pulls.default).toBeTruthy();
      expect(catalog.presentation.date.eventDayFormat).toBe('dd.MM.yyyy');
      expect(catalog.presentation.date.eventTimeFormat).toBe('HH:mm:ss');
      expect(catalog.presentation.date.eventUnavailableTime).toBe('--:--:--');
      expect(Object.isFrozen(catalog.presentation.config)).toBe(true);
    }
  });

  it('provides CSV export copy and menu actions for every locale', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.csv.selectTarget).toBeTruthy();
      expect(catalog.csv.caption).toBeTruthy();
      expect(catalog.csv.staging).toBeTruthy();
      expect(catalog.menu.buttons.exportCsv).toBeTruthy();
      expect(catalog.menu.submenus.sensorsExportCsv).toBeTruthy();
    }
  });

  it('provides application log copy and history actions for every locale', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.logs.application.outputCaption).toBeTruthy();
      expect(catalog.logs.application.errorCaption).toBeTruthy();
      expect(catalog.logs.application.outputEmpty).toBeTruthy();
      expect(catalog.logs.application.errorEmpty).toBeTruthy();
      expect(catalog.logs.application.truncated).toBeTruthy();
      expect(catalog.logs.application.unavailable).toBeTruthy();
      expect(catalog.logs.application.invalidArguments).toBeTruthy();
      expect(catalog.home.history.applicationLogs).toBeTruthy();
      expect(catalog.home.history.errors).toBeTruthy();
    }
  });

  it('provides contextual sensor cancellation and language-return copy in every locale', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.config.cancelSensorSetup).toBeTruthy();
      expect(catalog.language.updateFailed).toBeTruthy();
      expect(catalog.language.retryLanguageChange).toBeTruthy();
      expect(catalog.language.returnToMore).toBeTruthy();
      expect(catalog.language.restoreMoreFailed).toBeTruthy();
    }
  });

  it('provides the complete Drive connection copy in every locale', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      expect(catalog.gdriveConnection).toEqual(expect.objectContaining({
        guide: expect.any(String),
        openConsole: expect.any(String),
        documentInvalid: expect.any(String),
        unsupportedClientType: expect.any(String),
        clientRejected: expect.any(String),
        setupBusy: expect.any(String),
        setupExpired: expect.any(String),
        policyBlocked: expect.any(String),
        rateLimited: expect.any(String),
        temporaryUnavailable: expect.any(String),
        providerResponse: expect.any(String),
      }));
    }
  });

  it('provides the complete Home rendering catalog with equal shapes in every locale', () => {
    const [english, russian, ukrainian] = [catalogs.en, catalogs.ru, catalogs.uk];

    expect(english.home).toEqual(expect.objectContaining({
      title: expect.any(String),
      verdicts: expect.objectContaining({
        attention: expect.any(Function),
        unavailable: expect.any(String),
        normal: expect.any(String),
      }),
      buttons: expect.objectContaining({
        sensors: expect.any(String),
        camera: expect.any(String),
        notifications: expect.any(String),
        more: expect.any(String),
        checkNow: expect.any(String),
      }),
      sensors: expect.objectContaining({
        title: expect.any(String),
        row: expect.any(Function),
        page: expect.any(Function),
        clamp: expect.any(Function),
        emptyMember: expect.any(String),
        emptyAdmin: expect.any(String),
        setupSensors: expect.any(String),
      }),
      recovery: expect.objectContaining({
        stale: expect.any(String),
        updating: expect.any(String),
        unavailable: expect.any(String),
        openNewHome: expect.any(String),
        retryReturn: expect.any(String),
        closed: expect.any(String),
      }),
      workflow: expect.objectContaining({
        backTo: expect.any(Function),
        cancel: expect.any(Function),
        home: expect.any(String),
        workContinues: expect.any(Function),
        unfinishedSetupExpired: expect.any(String),
        retryReturn: expect.any(String),
        returnUnavailable: expect.any(String),
        outcomeNotice: expect.any(Function),
      }),
      navigation: expect.objectContaining({
        backTo: expect.objectContaining({
          history: expect.any(String),
          more: expect.any(String),
          'admin-system': expect.any(String),
        }),
      }),
      legacyNotifications: expect.objectContaining({
        title: expect.any(String),
        muteSensors: expect.any(String),
        unmuteSensors: expect.any(String),
        quietHours: expect.any(String),
      }),
    }));
    expect(Object.keys(russian.home).sort()).toEqual(Object.keys(english.home).sort());
    expect(Object.keys(ukrainian.home).sort()).toEqual(Object.keys(english.home).sort());
    expect(english.home.recovery.retryReturn).toBe('Retry return');
    expect(russian.home.recovery.retryReturn).toBe('Повторить возврат');
    expect(ukrainian.home.recovery.retryReturn).toBe('Повторити повернення');
    expect(english.home.adminSystem.cleanupThreshold).toBeTruthy();
    expect(english.home.adminCleanupThreshold.title).toBeTruthy();
    expect(english.home.workflow.backTo('History')).toBe('Back to History');
    expect(english.home.workflow.cancel('sensor setup')).toBe('Cancel sensor setup');
    expect(english.home.workflow.workContinues('CSV export')).toBe('CSV export · work continues');
    expect(english.home.workflow.unfinishedSetupExpired).toContain('expired');
    expect(english.home.workflow.retryReturn).toBe('Retry return');
    expect(english.home.workflow.returnUnavailable).toContain('temporarily unavailable');
    expect(english.home.workflow.outcomeNotice('Restart complete.')).toBe('Restart complete.');
  });
});

describe('system online notice', () => {
  const healthy = {
    sensorsOnline: 1,
    sensorsTotal: 2,
    dbRecovery: null,
    clockSynchronized: true,
    archiveRecovered: true,
    now: new Date('2030-01-01T12:00:00Z'),
  } as const;

  const allWarnings = {
    ...healthy,
    dbRecovery: 'recreated_empty',
    clockSynchronized: false,
    archiveRecovered: false,
  } as const;

  function stampFor(catalog: (typeof catalogs)['en']): string {
    return format(healthy.now, catalog.presentation.date.format);
  }

  it('renders a healthy boot notice byte-for-byte as before the archive flag', () => {
    expect(catalogs.en.system.online(healthy))
      .toBe(`🟢 System online\n🔌 Sensors: 1/2 online\n${stampFor(catalogs.en)}`);
    expect(catalogs.ru.system.online(healthy))
      .toBe(`🟢 Система в сети\n🔌 Датчики: 1/2 в сети\n${stampFor(catalogs.ru)}`);
    expect(catalogs.uk.system.online(healthy))
      .toBe(`🟢 Система в мережі\n🔌 Датчики: 1/2 у мережі\n${stampFor(catalogs.uk)}`);
  });

  it('adds one archive warning line in every locale when archive recovery failed', () => {
    for (const catalog of [catalogs.en, catalogs.ru, catalogs.uk]) {
      const healthyLines = catalog.system.online(healthy).split('\n');
      const failedLines = catalog.system.online({ ...healthy, archiveRecovered: false }).split('\n');

      expect(failedLines).toHaveLength(healthyLines.length + 1);
      const [added] = failedLines.filter((line) => !healthyLines.includes(line));
      expect(added).toMatch(/^⚠️ /);
    }

    expect(catalogs.en.system.online({ ...healthy, archiveRecovered: false }))
      .toContain('Archive recovery failed');
    expect(catalogs.ru.system.online({ ...healthy, archiveRecovered: false }))
      .toContain('архива');
    expect(catalogs.uk.system.online({ ...healthy, archiveRecovered: false }))
      .toContain('архіву');
  });

  it('orders the archive warning between the database and clock warnings', () => {
    expect(catalogs.en.system.online(allWarnings).split('\n')).toEqual([
      '🟢 System online',
      '🔌 Sensors: 1/2 online',
      '⚠️ Database was recreated empty after corruption — re-import config.',
      '⚠️ Archive recovery failed — video uploads and backups are paused until the next restart.',
      '⚠️ System clock is not synchronized — early timestamps may drift.',
      stampFor(catalogs.en),
    ]);

    for (const catalog of [catalogs.ru, catalogs.uk]) {
      const lines = catalog.system.online(allWarnings).split('\n');
      const warnings = lines.filter((line) => line.startsWith('⚠️ '));

      expect(lines).toHaveLength(6);
      expect(warnings).toHaveLength(3);
      expect(warnings[1]).toBe(lines[3]);
      expect(warnings[1]).toMatch(/арх[иі]в/);
    }
  });
});
