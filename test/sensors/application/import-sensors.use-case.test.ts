import { describe, expect, it, vi } from 'vitest';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { ImportedSensor } from '../../../src/sensors/domain/config-import';
import { ImportSensorsUseCase } from '../../../src/sensors/application/import-sensors.use-case';
import { ReloadSensorsUseCase } from '../../../src/sensors/application/reload-sensors.use-case';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';

const clock: ClockPort = { now: () => new Date('2030-01-01T00:00:00.000Z') };

function makeSensor(overrides: Partial<Sensor> & Pick<Sensor, 'name'>): Sensor {
  return {
    id: overrides.id ?? `id-${overrides.name}`,
    name: overrides.name,
    type: overrides.type ?? 'digital',
    config: overrides.config ?? { pin: 17 },
    enabled: true,
    debounceMs: overrides.debounceMs ?? 10_000,
    severity: overrides.severity ?? 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

function makeUseCase(seed: Sensor[] = []): {
  useCase: ImportSensorsUseCase;
  repo: InMemorySensorRepository;
  reload: ReloadSensorsUseCase;
} {
  const repo = new InMemorySensorRepository(seed);
  const reload = {
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReloadSensorsUseCase;
  const useCase = new ImportSensorsUseCase(repo, clock, reload);
  return { useCase, repo, reload };
}

const importedDigital: ImportedSensor = {
  name: 'front_door',
  type: 'digital',
  config: { pin: 17 },
  debounceMs: 10_000,
  severity: 'info',
};

describe('ImportSensorsUseCase', () => {
  it('diffs adds, updates and archives without writing in prepare', async () => {
    const { useCase, repo } = makeUseCase([
      makeSensor({ name: 'front_door', config: { pin: 17 } }),
      makeSensor({ name: 'old_sensor', config: { pin: 5 } }),
    ]);

    const plan = await useCase.prepare([
      { ...importedDigital, config: { pin: 22 } },
      { name: 'window_1', type: 'digital', config: { pin: 6 }, debounceMs: 10_000, severity: 'info' },
    ]);

    expect(plan.summary.added).toEqual(['window_1']);
    expect(plan.summary.updated[0]).toMatchObject({ name: 'front_door' });
    expect(plan.summary.updated[0].detail).toContain('pin 17→22');
    expect(plan.summary.archived).toEqual(['old_sensor']);

    // prepare must not mutate the repository
    const current = await repo.loadEnabled();
    expect(current.map((s) => s.name).sort()).toEqual(['front_door', 'old_sensor']);
  });

  it('commit applies the batch atomically and reloads', async () => {
    const { useCase, repo, reload } = makeUseCase([
      makeSensor({ name: 'front_door', config: { pin: 17 } }),
      makeSensor({ name: 'old_sensor', config: { pin: 5 } }),
    ]);

    const plan = await useCase.prepare([
      { ...importedDigital, config: { pin: 22 } },
      { name: 'window_1', type: 'digital', config: { pin: 6 }, debounceMs: 10_000, severity: 'info' },
    ]);
    const summary = await useCase.commit(plan);

    expect(summary.added).toEqual(['window_1']);
    expect(reload.execute).toHaveBeenCalledOnce();

    const names = (await repo.loadEnabled()).map((s) => s.name).sort();
    expect(names).toEqual(['front_door', 'window_1']);

    const frontDoor = (await repo.loadEnabled()).find((s) => s.name === 'front_door');
    expect(frontDoor?.config).toEqual({ pin: 22 });
  });

  it('produces an empty plan when the import matches the current config', async () => {
    const { useCase } = makeUseCase([
      makeSensor({ name: 'front_door', config: { pin: 17 } }),
    ]);

    const plan = await useCase.prepare([importedDigital]);

    expect(plan.summary.added).toHaveLength(0);
    expect(plan.summary.updated).toHaveLength(0);
    expect(plan.summary.archived).toHaveLength(0);
  });

  it('detects UART threshold changes', async () => {
    const { useCase } = makeUseCase([
      makeSensor({
        name: 'co2',
        type: 'uart',
        config: { port: '/dev/ttyS0', baudRate: 9600, thresholds: { warning: 800, critical: 1200 } },
        debounceMs: 0,
        severity: 'warning',
      }),
    ]);

    const plan = await useCase.prepare([
      {
        name: 'co2',
        type: 'uart',
        config: { port: '/dev/ttyS0', baudRate: 9600, thresholds: { warning: 900, critical: 1500 } },
        debounceMs: 0,
        severity: 'warning',
      },
    ]);

    expect(plan.summary.updated[0].detail).toContain('thresholds changed');
  });
});
