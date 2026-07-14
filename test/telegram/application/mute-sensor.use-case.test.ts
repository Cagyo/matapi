import { describe, expect, it, vi } from 'vitest';
import { MuteSensorUseCase } from '../../../src/telegram/application/mute-sensor.use-case';
import { SensorAlreadyMutedError } from '../../../src/telegram/domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../../../src/telegram/domain/errors/sensor-not-found.error';

describe('MuteSensorUseCase', () => {
  it('keeps legacy not-found and already-muted semantics before using the shared setter', async () => {
    const setMuted = { execute: vi.fn() };
    const missing = new MuteSensorUseCase({ findEnabledByName: async () => null }, setMuted);
    await expect(missing.execute(42, 'ghost')).rejects.toBeInstanceOf(SensorNotFoundError);

    const target = { ref: { kind: 'camera' as const, id: 'cam-1' }, name: 'front_door_cam', kind: 'camera' as const, muted: false };
    const useCase = new MuteSensorUseCase({ findEnabledByName: async () => target }, setMuted);
    await useCase.execute(42, 'front_door_cam');
    expect(setMuted.execute).toHaveBeenCalledWith(42, target.ref, true);

    const alreadyMuted = new MuteSensorUseCase({ findEnabledByName: async () => ({ ...target, muted: true }) }, setMuted);
    await expect(alreadyMuted.execute(42, 'front_door_cam')).rejects.toBeInstanceOf(SensorAlreadyMutedError);
  });
});
