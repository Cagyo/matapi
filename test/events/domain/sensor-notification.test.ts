import { describe, expect, it } from 'vitest';
import { formatSensorNotification } from '../../../src/events/domain/sensor-notification';

describe('formatSensorNotification', () => {
  it('formats a digital open event with the door icon', () => {
    expect(
      formatSensorNotification({
        type: 'digital',
        name: 'front_door',
        value: true,
        severity: 'info',
      }),
    ).toBe('🚪 front_door: OPENED');
  });

  it('maps falsy digital values to CLOSED', () => {
    expect(
      formatSensorNotification({
        type: 'digital',
        name: 'front_door',
        value: 'false',
        severity: 'info',
      }),
    ).toBe('🚪 front_door: CLOSED');
  });

  it('appends a warning marker for non-info severity', () => {
    expect(
      formatSensorNotification({
        type: 'digital',
        name: 'water_kitchen',
        value: true,
        severity: 'warning',
      }),
    ).toBe('🚪 water_kitchen: OPENED ⚠️');
  });

  it('formats a uart value with ppm units', () => {
    expect(
      formatSensorNotification({
        type: 'uart',
        name: 'co2_living',
        value: 950,
        severity: 'warning',
      }),
    ).toBe('🌬️ co2_living: 950 ppm ⚠️');
  });

  it('falls back to a bullet and raw value for unknown types', () => {
    expect(
      formatSensorNotification({
        type: null,
        name: 'thing',
        value: 'STARTED',
        severity: 'info',
      }),
    ).toBe('• thing: STARTED');
  });
});
