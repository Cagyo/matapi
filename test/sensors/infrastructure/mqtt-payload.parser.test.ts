import { describe, it, expect } from 'vitest';
import { parseMqttPayload } from '../../../src/sensors/infrastructure/mqtt-payload.parser';

describe('parseMqttPayload', () => {
  it('parses Zigbee2MQTT occupancy payload', () => {
    const payload = Buffer.from(JSON.stringify({ occupancy: true, linkquality: 65, battery: 100 }));
    const result = parseMqttPayload(payload, 'zigbee2mqtt');
    expect(result).toEqual({
      value: true,
      raw: { occupancy: true, linkquality: 65, battery: 100 },
    });
  });

  it('parses Zigbee2MQTT temperature payload', () => {
    const payload = Buffer.from(JSON.stringify({ temperature: 21.5, humidity: 45 }));
    const result = parseMqttPayload(payload, 'zigbee2mqtt');
    expect(result?.value).toBe(21.5);
  });

  it('parses Tasmota nested ENERGY payload', () => {
    const payload = Buffer.from(
      JSON.stringify({
        Time: '2026-07-02T12:00:00',
        ENERGY: { Total: 12.34, Power: 45, Voltage: 230 },
      }),
    );
    const result = parseMqttPayload(payload, 'tasmota');
    expect(result?.value).toBe(45);
  });

  it('extracts nested value via valueKey', () => {
    const payload = Buffer.from(
      JSON.stringify({
        ENERGY: { Voltage: 230, Power: 100 },
      }),
    );
    const result = parseMqttPayload(payload, 'json', 'ENERGY.Voltage');
    expect(result?.value).toBe(230);
  });

  it('parses raw string boolean ON/OFF', () => {
    expect(parseMqttPayload(Buffer.from('ON'), 'auto')?.value).toBe(true);
    expect(parseMqttPayload(Buffer.from('OFF'), 'auto')?.value).toBe(false);
  });

  it('parses raw numeric string', () => {
    expect(parseMqttPayload(Buffer.from('24.8'), 'auto')?.value).toBe(24.8);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseMqttPayload(Buffer.from('{bad json'), 'auto');
    expect(result?.value).toBe('{bad json');
  });

  it('returns null on empty buffer', () => {
    expect(parseMqttPayload(Buffer.from('   '), 'auto')).toBeNull();
  });
});
