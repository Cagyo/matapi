import { describe, expect, it } from 'vitest';
import {
  cameraConfigIssues,
  mqttConfigIssues,
} from '../../../src/sensors/domain/sensor-type-config-validation';

describe('mqttConfigIssues', () => {
  it('accepts the minimal MQTT shape', () => {
    expect(mqttConfigIssues({ topic: 'home/front-door' })).toEqual([]);
  });

  it('accepts all supported MQTT options including zero reconnect delay', () => {
    expect(
      mqttConfigIssues({
        topic: 'home/front-door',
        qos: 2,
        format: 'zigbee2mqtt',
        reconnectMs: 0,
      }),
    ).toEqual([]);
  });

  it('reports a missing MQTT topic', () => {
    expect(mqttConfigIssues({ topic: '   ' })).toContain(
      'missing required string property "topic"',
    );
  });

  it('reports an unsupported MQTT quality of service', () => {
    expect(mqttConfigIssues({ topic: 'home/front-door', qos: 3 })).toContain(
      'invalid "qos": 3',
    );
  });

  it('reports an unsupported MQTT payload format', () => {
    expect(
      mqttConfigIssues({ topic: 'home/front-door', format: 'plaintext' }),
    ).toContain('invalid "format": "plaintext"');
  });

  it('reports a non-integer MQTT reconnect delay', () => {
    expect(
      mqttConfigIssues({ topic: 'home/front-door', reconnectMs: 1.5 }),
    ).toContain('invalid "reconnectMs": 1.5');
  });

  it('reports a non-finite MQTT reconnect delay', () => {
    expect(
      mqttConfigIssues({ topic: 'home/front-door', reconnectMs: Infinity }),
    ).toContain('invalid "reconnectMs": Infinity');
  });
});

describe('cameraConfigIssues', () => {
  it('accepts the minimal camera shape', () => {
    expect(cameraConfigIssues({ type: 'usb' })).toEqual([]);
  });

  it('accepts a fully populated RTSP camera shape', () => {
    expect(
      cameraConfigIssues({
        type: 'rtsp',
        url: 'rtsp://camera.local/live',
        snapshotCacheTtlMs: 0,
        resolution: { width: 1920, height: 1080 },
      }),
    ).toEqual([]);
  });

  it('reports a missing camera type', () => {
    expect(cameraConfigIssues({})).toContain(
      'invalid camera "type": undefined',
    );
  });

  it('reports a missing URL for an MJPEG camera', () => {
    expect(cameraConfigIssues({ type: 'mjpeg' })).toContain(
      'camera type "mjpeg" requires a valid string "url"',
    );
  });

  it('reports non-integer cache TTL and resolution dimensions', () => {
    expect(
      cameraConfigIssues({
        type: 'usb',
        snapshotCacheTtlMs: 1.5,
        resolution: { width: 0, height: 720.5 },
      }),
    ).toEqual([
      'invalid "snapshotCacheTtlMs": 1.5',
      'invalid "resolution.width": 0',
      'invalid "resolution.height": 720.5',
    ]);
  });

  it('reports a non-finite camera cache TTL', () => {
    expect(
      cameraConfigIssues({ type: 'usb', snapshotCacheTtlMs: Infinity }),
    ).toContain('invalid "snapshotCacheTtlMs": Infinity');
  });
});
