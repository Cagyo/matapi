import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
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

  it('carries no actor identity in the denial', () => {
    const denials = [9, 404].map((userId) => {
      try {
        adapter.requireAdmin(userId);
        return expect.unreachable('the denial should have been thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CameraSourceAdminRequiredError);
        return error as CameraSourceAdminRequiredError;
      }
    });

    // Two different actors, one indistinguishable denial.
    expect(denials[0].message).toBe(denials[1].message);
    expect(Object.keys(denials[0]).sort()).toEqual(['code', 'name']);
  });

  it('denies rather than leaking a driver failure when the database cannot answer', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    context.close();

    expect(() => adapter.requireAdmin(7)).toThrow(CameraSourceAdminRequiredError);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).not.toContain('7');
    warn.mockRestore();
  });
});
