import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ListCamerasUseCase } from '../../../src/camera/application/list-cameras.use-case';
import { ListLiveSourcesUseCase } from '../../../src/camera/application/list-live-sources.use-case';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { InMemoryFeatureQuery } from '../../../src/features/infrastructure/in-memory-feature.query';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { ExportConfigUseCase } from '../../../src/telegram/application/export-config.use-case';
import { YamlConfigCodec } from '../../../src/telegram/infrastructure/yaml-config-codec.adapter';

const clock: ClockPort = { now: () => new Date('2026-04-08T10:00:00.000Z') };

const sensor: Sensor = {
  id: 's1',
  name: 'front_door',
  type: 'digital',
  config: { pin: 17, activeLow: true, pull: 'up' },
  enabled: true,
  debounceMs: 10_000,
  severity: 'info',
  lastValue: null,
  lastValueAt: null,
};

describe('ExportConfigUseCase', () => {
  it('serializes sensors, cameras and features into a dated YAML document', async () => {
    const sensors: SensorQueryPort = {
      listEnabled: vi.fn().mockResolvedValue([sensor]),
      listDashboardPage: vi.fn().mockResolvedValue({
        sensors: [], requestedPage: 0, page: 0, pageCount: 0, total: 0, clamped: false,
      }),
      findById: vi.fn(),
      findByIdIncludingArchived: vi.fn(),
      findByName: vi.fn(),
      listHistoryTargets: vi.fn().mockResolvedValue({ targets: [], page: 0, pageCount: 0 }),
    };
    const cameras = {
      execute: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'front_door', type: 'motion', config: { motionConfigPath: '/etc/motion/motion.conf' }, enabled: true },
      ]),
    } as unknown as ListCamerasUseCase;
    const features = new InMemoryFeatureQuery([
      { name: 'digital', enabled: true, installed: true, config: null },
      { name: 'motion', enabled: false, installed: true, config: null },
    ]);
    const liveSources = {
      execute: vi.fn().mockResolvedValue([
        {
          cameraId: 'c1',
          cameraName: 'front_door',
          summary: {
            scheme: 'rtsp',
            host: 'cam.local:554',
            transport: 'tcp',
            tlsMode: 'none',
            profile: 'eco',
            substreamHost: 'cam.local:8554',
            ready: true,
          },
        },
      ]),
    } as unknown as ListLiveSourcesUseCase;
    const codec = new YamlConfigCodec();

    const useCase = new ExportConfigUseCase(sensors, cameras, liveSources, features, codec, clock);
    const { yaml, filename } = await useCase.execute();

    expect(filename).toBe('home-worker-config-2026-04-08.yml');

    const parsed = parse(yaml);
    expect(parsed.sensors).toEqual([
      {
        name: 'front_door',
        type: 'digital',
        config: { pin: 17, activeLow: true, pull: 'up' },
        debounce_ms: 10_000,
        severity: 'info',
      },
    ]);
    expect(parsed.cameras).toEqual([
      {
        name: 'front_door',
        type: 'motion',
        config: { motionConfigPath: '/etc/motion/motion.conf' },
      },
    ]);
    expect(parsed.features).toEqual([
      { name: 'digital', enabled: true },
      { name: 'motion', enabled: false },
    ]);
    expect(parsed.live_sources).toEqual([
      {
        camera_name: 'front_door',
        scheme: 'rtsp',
        host: 'cam.local:554',
        transport: 'tcp',
        tls_mode: 'none',
        profile: 'eco',
        substream_host: 'cam.local:8554',
        ready: false,
      },
    ]);
    expect(yaml).not.toMatch(/user|password|private|token|ciphertext|nonce|auth_tag/i);
  });
});
