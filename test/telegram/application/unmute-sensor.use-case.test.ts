import { describe, expect, it, vi } from 'vitest';
import { UnmuteSensorUseCase } from '../../../src/telegram/application/unmute-sensor.use-case';
import { SensorNotFoundError } from '../../../src/telegram/domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../../../src/telegram/domain/errors/sensor-not-muted.error';

describe('UnmuteSensorUseCase', () => {
  it('keeps legacy not-found and not-muted semantics before using the shared setter', async () => {
    const setMuted = { execute: vi.fn() };
    const missing = new UnmuteSensorUseCase({ findEnabledByName: async () => null }, setMuted);
    await expect(missing.execute(42, 'ghost')).rejects.toBeInstanceOf(SensorNotFoundError);

    const target = { ref: { kind: 'sensor' as const, id: 'door-1' }, name: 'door_1', kind: 'sensor' as const, muted: true };
    const useCase = new UnmuteSensorUseCase({ findEnabledByName: async () => target }, setMuted);
    await useCase.execute(42, 'door_1');
    expect(setMuted.execute).toHaveBeenCalledWith(42, target.ref, false);

    const notMuted = new UnmuteSensorUseCase({ findEnabledByName: async () => ({ ...target, muted: false }) }, setMuted);
    await expect(notMuted.execute(42, 'door_1')).rejects.toBeInstanceOf(SensorNotMutedError);
  });
});
