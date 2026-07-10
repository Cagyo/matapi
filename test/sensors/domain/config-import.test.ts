import { describe, expect, it } from 'vitest';
import { validateImportConfig } from '../../../src/sensors/domain/config-import';

const validDigital = {
  name: 'front_door',
  type: 'digital',
  config: { pin: 17, activeLow: true, pull: 'up' },
  debounce_ms: 10_000,
  severity: 'info',
};

const validUart = {
  name: 'co2_living',
  type: 'uart',
  config: {
    port: '/dev/ttyS0',
    baudRate: 9600,
    thresholds: { warning: 800, critical: 1200 },
  },
  debounce_ms: 0,
  severity: 'warning',
};

const validMqtt = {
  name: 'front_door_mqtt',
  type: 'mqtt',
  config: { topic: 'home/front-door', qos: 1, format: 'json', reconnectMs: 0 },
};

const validCamera = {
  name: 'front_door_camera',
  type: 'camera',
  config: {
    type: 'mjpeg',
    url: 'http://camera.local/mjpeg',
    snapshotCacheTtlMs: 0,
    resolution: { width: 1280, height: 720 },
  },
};

describe('validateImportConfig', () => {
  it('accepts a valid sensors document', () => {
    const result = validateImportConfig({
      sensors: [validDigital, validUart, validMqtt, validCamera],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sensors).toHaveLength(4);
      expect(result.sensors[0]).toMatchObject({
        name: 'front_door',
        type: 'digital',
        debounceMs: 10_000,
        severity: 'info',
      });
    }
  });

  it('applies type-based default debounce and info severity when omitted', () => {
    const result = validateImportConfig({
      sensors: [
        { name: 'd1', type: 'digital', config: { pin: 5 } },
        {
          name: 'u1',
          type: 'uart',
          config: {
            port: '/dev/ttyS0',
            baudRate: 9600,
            thresholds: { warning: 1, critical: 2 },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sensors[0]).toMatchObject({ debounceMs: 10_000, severity: 'info' });
      expect(result.sensors[1]).toMatchObject({ debounceMs: 0, severity: 'info' });
    }
  });

  it('fails when the sensors list is missing', () => {
    const result = validateImportConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/sensors/i);
    }
  });

  it('fails when the root is not a mapping', () => {
    expect(validateImportConfig('nope').ok).toBe(false);
    expect(validateImportConfig(null).ok).toBe(false);
  });

  it('reports an out-of-range pin', () => {
    const result = validateImportConfig({
      sensors: [{ name: 'door_3', type: 'digital', config: { pin: 99 } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.stringContaining('invalid pin number 99'),
      );
    }
  });

  it('reports duplicate GPIO pins across digital sensors', () => {
    const result = validateImportConfig({
      sensors: [
        { name: 'door_1', type: 'digital', config: { pin: 17 } },
        { name: 'window_2', type: 'digital', config: { pin: 17 } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('GPIO pin 17'))).toBe(true);
    }
  });

  it('reports duplicate sensor names', () => {
    const result = validateImportConfig({
      sensors: [
        { name: 'dup', type: 'digital', config: { pin: 1 } },
        { name: 'dup', type: 'digital', config: { pin: 2 } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('duplicate name'))).toBe(true);
    }
  });

  it('rejects an invalid sensor name', () => {
    const result = validateImportConfig({
      sensors: [{ name: 'bad name!', type: 'digital', config: { pin: 1 } }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown type', () => {
    const result = validateImportConfig({
      sensors: [{ name: 'x', type: 'laser', config: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('invalid type'))).toBe(true);
    }
  });

  it('rejects an invalid baud rate', () => {
    const result = validateImportConfig({
      sensors: [
        {
          name: 'co2',
          type: 'uart',
          config: {
            port: '/dev/ttyS0',
            baudRate: 12345,
            thresholds: { warning: 1, critical: 2 },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('baudRate'))).toBe(true);
    }
  });

  it('rejects UART thresholds where warning >= critical', () => {
    const result = validateImportConfig({
      sensors: [
        {
          name: 'co2',
          type: 'uart',
          config: {
            port: '/dev/ttyS0',
            baudRate: 9600,
            thresholds: { warning: 1200, critical: 800 },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('less than'))).toBe(true);
    }
  });

  it('rejects a missing UART port', () => {
    const result = validateImportConfig({
      sensors: [
        {
          name: 'co2',
          type: 'uart',
          config: { baudRate: 9600, thresholds: { warning: 1, critical: 2 } },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("'port'"))).toBe(true);
    }
  });

  it('rejects an invalid severity and a negative debounce', () => {
    const result = validateImportConfig({
      sensors: [
        {
          name: 'd1',
          type: 'digital',
          config: { pin: 1 },
          severity: 'urgent',
          debounce_ms: -5,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('severity'))).toBe(true);
      expect(result.errors.some((e) => e.includes('debounce_ms'))).toBe(true);
    }
  });

  it('labels a MQTT sensor missing its topic', () => {
    const result = validateImportConfig({
      sensors: [{ name: 'mqtt_door', type: 'mqtt', config: {} }],
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Sensor \'mqtt_door\': missing required string property "topic"'],
    });
  });

  it('labels a camera sensor missing its type', () => {
    const result = validateImportConfig({
      sensors: [{ name: 'camera_door', type: 'camera', config: {} }],
    });

    expect(result).toEqual({
      ok: false,
      errors: ['Sensor \'camera_door\': invalid camera "type": undefined'],
    });
  });
});
