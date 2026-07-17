import { describe, expect, it } from 'vitest';
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
  });
});
