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
});
