import { describe, expect, it } from 'vitest';
import { InMemoryUserSensorMuteRepository } from '../../../src/telegram/infrastructure/in-memory-user-sensor-mute.repository';

describe('InMemoryUserSensorMuteRepository', () => {
  it('counts only mutes owned by the requested user', async () => {
    const repository = new InMemoryUserSensorMuteRepository();
    await repository.mute(1, 'door');
    await repository.mute(1, 'co2');
    await repository.mute(2, 'door');

    await expect(repository.countForUser(1)).resolves.toBe(2);
    await expect(repository.countForUser(2)).resolves.toBe(1);
    await expect(repository.countForUser(3)).resolves.toBe(0);
  });
});
