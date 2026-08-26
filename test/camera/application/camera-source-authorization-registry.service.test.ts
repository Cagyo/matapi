import { describe, expect, it, vi } from 'vitest';
import { CameraSourceAuthorizationRegistry } from '../../../src/camera/application/camera-source-authorization-registry.service';
import { CameraSourceAdminRequiredError } from '../../../src/camera/domain/errors/camera-source-admin-required.error';

describe('CameraSourceAuthorizationRegistry', () => {
  it('denies every actor while no authorization is registered', () => {
    const registry = new CameraSourceAuthorizationRegistry();

    expect(() => registry.requireAdmin(7)).toThrow(CameraSourceAdminRequiredError);
  });

  it('delegates each call to the registered authorization', () => {
    const registry = new CameraSourceAuthorizationRegistry();
    const authorization = { requireAdmin: vi.fn() };
    registry.register(authorization);

    registry.requireAdmin(7);
    registry.requireAdmin(9);

    expect(authorization.requireAdmin).toHaveBeenCalledTimes(2);
    expect(authorization.requireAdmin).toHaveBeenNthCalledWith(1, 7);
    expect(authorization.requireAdmin).toHaveBeenNthCalledWith(2, 9);
  });

  it('re-asks the authorization instead of caching an earlier success', () => {
    const registry = new CameraSourceAuthorizationRegistry();
    const denial = new CameraSourceAdminRequiredError();
    const authorization = {
      requireAdmin: vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw denial; }),
    };
    registry.register(authorization);

    expect(() => registry.requireAdmin(7)).not.toThrow();
    expect(() => registry.requireAdmin(7)).toThrow(denial);
  });

  it('rejects a conflicting registration and keeps the first authorization', () => {
    const registry = new CameraSourceAuthorizationRegistry();
    const first = { requireAdmin: vi.fn() };
    registry.register(first);

    expect(() => registry.register({ requireAdmin: vi.fn() })).toThrow(RangeError);

    registry.requireAdmin(7);
    expect(first.requireAdmin).toHaveBeenCalledOnce();
  });
});
