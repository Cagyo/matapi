import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleUserSensorMuteRepository } from '../../../src/telegram/infrastructure/drizzle-user-sensor-mute.repository';
import { DrizzleUserRepository } from '../../../src/telegram/infrastructure/drizzle-user.repository';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleUserSensorMuteRepository', () => {
  let context: TestDatabaseContext;
  let repository: DrizzleUserSensorMuteRepository;

  beforeEach(() => {
    context = createTestDatabase();
    repository = new DrizzleUserSensorMuteRepository(context.appDb);
  });

  afterEach(() => context.close());

  it('counts only the requested user\'s muted sensors', async () => {
    const users = new DrizzleUserRepository(context.appDb);
    await users.createUser({
      telegramId: 1, name: 'One', role: 'user', locale: 'en', createdAt: new Date(),
    });
    await users.createUser({
      telegramId: 2, name: 'Two', role: 'user', locale: 'en', createdAt: new Date(),
    });
    await repository.mute(1, 'door');
    await repository.mute(1, 'co2');
    await repository.mute(2, 'door');

    await expect(repository.countForUser(1)).resolves.toBe(2);
    await expect(repository.countForUser(2)).resolves.toBe(1);
    await expect(repository.countForUser(3)).resolves.toBe(0);
  });

  it('normalizes and deduplicates legacy sensor rows before counting', async () => {
    const users = new DrizzleUserRepository(context.appDb);
    await users.createUser({
      telegramId: 1, name: 'One', role: 'user', locale: 'en', createdAt: new Date(),
    });
    await repository.mute(1, 'door');
    await repository.mute(1, { kind: 'sensor', id: 'door' });

    await expect(repository.countForUser(1)).resolves.toBe(1);
    await expect(repository.listForUser(1)).resolves.toEqual([{ kind: 'sensor', id: 'door' }]);
  });

  it('migrates a legacy mute without exposing a transient mixed representation', async () => {
    const users = new DrizzleUserRepository(context.appDb);
    await users.createUser({
      telegramId: 1, name: 'One', role: 'user', locale: 'en', createdAt: new Date(),
    });
    await repository.mute(1, 'door');

    const migration = repository.isMuted(1, { kind: 'sensor', id: 'door' });

    expect(mutedSensorIds()).toEqual(['sensor:door']);
    await expect(migration).resolves.toBe(true);
  });

  it('rolls back a failed legacy-mute migration and preserves the legacy acknowledgement', async () => {
    const users = new DrizzleUserRepository(context.appDb);
    await users.createUser({
      telegramId: 1, name: 'One', role: 'user', locale: 'en', createdAt: new Date(),
    });
    await repository.mute(1, 'door');
    context.sqlite.exec(`
      CREATE TRIGGER reject_legacy_mute_delete
      BEFORE DELETE ON user_sensor_mutes
      WHEN OLD.sensor_id = 'door'
      BEGIN
        SELECT RAISE(ABORT, 'legacy mute deletion rejected');
      END;
    `);

    await expect(repository.isMuted(1, { kind: 'sensor', id: 'door' })).resolves.toBe(true);
    expect(mutedSensorIds()).toEqual(['door']);
  });

  function mutedSensorIds(): string[] {
    return context.sqlite
      .prepare('SELECT sensor_id FROM user_sensor_mutes WHERE user_id = ? ORDER BY sensor_id')
      .all(1)
      .map((row) => row.sensor_id as string);
  }
});
