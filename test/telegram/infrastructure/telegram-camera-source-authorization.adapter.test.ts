import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../../src/database/schema';
import { CameraSourceAdminRequiredError } from '../../../src/camera/domain/errors/camera-source-admin-required.error';
import { TelegramCameraSourceAuthorizationAdapter } from '../../../src/telegram/infrastructure/telegram-camera-source-authorization.adapter';
import { createTestDatabase, TestDatabaseContext } from '../../helpers/database';

describe('TelegramCameraSourceAuthorizationAdapter', () => {
  let context: TestDatabaseContext;
  let adapter: TelegramCameraSourceAuthorizationAdapter;

  beforeEach(() => {
    context = createTestDatabase();
    adapter = new TelegramCameraSourceAuthorizationAdapter(context.appDb);
    context.db.insert(users).values([
      { telegramId: 7, name: 'Ada', role: 'admin' },
      { telegramId: 9, name: 'Bo', role: 'user' },
    ]).run();
  });

  afterEach(() => context.close());

  it('accepts an administrator without returning anything', () => {
    expect(adapter.requireAdmin(7)).toBeUndefined();
  });

  it('denies a non-admin member', () => {
    expect(() => adapter.requireAdmin(9)).toThrow(CameraSourceAdminRequiredError);
  });

  it('denies an unknown actor', () => {
    expect(() => adapter.requireAdmin(404)).toThrow(CameraSourceAdminRequiredError);
  });

  it('denies an administrator demoted between two calls', () => {
    adapter.requireAdmin(7);

    context.db.update(users).set({ role: 'user' }).where(eq(users.telegramId, 7)).run();

    expect(() => adapter.requireAdmin(7)).toThrow(CameraSourceAdminRequiredError);
  });

  it('keeps the actor identity out of the denial', () => {
    try {
      adapter.requireAdmin(9);
      expect.unreachable('the denial should have been thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CameraSourceAdminRequiredError);
      expect((error as Error).message).not.toContain('9');
    }
  });
});
