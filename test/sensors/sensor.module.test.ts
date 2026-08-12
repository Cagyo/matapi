import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { FEATURE_RUNTIME_LIFECYCLE } from '../../src/features/domain/ports/feature-runtime-lifecycle.port';
import { FeatureSensorRuntimeLifecycleService } from '../../src/sensors/application/feature-sensor-runtime-lifecycle.service';
import { SensorModule } from '../../src/sensors/sensor.module';

describe('SensorModule', () => {
  it('registers exactly the digital, uart, and zigbee runtime lifecycles', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SensorModule) as unknown[];
    const provider = providers.find((candidate): candidate is {
      provide: unknown;
      useFactory: (registry: { register: ReturnType<typeof vi.fn> }, sensorRegistry: unknown) => unknown;
    } => typeof candidate === 'object' && candidate !== null
      && 'provide' in candidate && candidate.provide === FeatureSensorRuntimeLifecycleService);
    expect(provider).toBeDefined();

    const lifecycleRegistry = { register: vi.fn<(name: string) => void>() };
    provider?.useFactory(lifecycleRegistry, {
      stopFeature: vi.fn(),
      resumeFeature: vi.fn(),
    });

    expect(lifecycleRegistry.register.mock.calls.map(([name]) => name)).toEqual([
      'digital', 'uart', 'zigbee',
    ]);
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provide: FeatureSensorRuntimeLifecycleService,
        inject: [FEATURE_RUNTIME_LIFECYCLE, expect.anything()],
      }),
    ]));
  });
});
