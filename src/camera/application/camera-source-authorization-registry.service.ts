import { Injectable } from '@nestjs/common';
import { CameraSourceAdminRequiredError } from '../domain/errors/camera-source-admin-required.error';
import type { CameraSourceAuthorizationPort } from '../domain/ports/camera-source-authorization.port';

/**
 * Composition seam that lets the Telegram context supply the role authority
 * without Camera importing it. Fail-closed on purpose: until an authorization
 * is registered every actor is denied, so a composition mistake cannot turn
 * into a silently unguarded mutation.
 */
@Injectable()
export class CameraSourceAuthorizationRegistry implements CameraSourceAuthorizationPort {
  private authorization: CameraSourceAuthorizationPort | null = null;

  register(authorization: CameraSourceAuthorizationPort): void {
    if (this.authorization) {
      throw new RangeError('Camera source authorization already registered');
    }
    this.authorization = authorization;
  }

  requireAdmin(userId: number): void {
    if (!this.authorization) throw new CameraSourceAdminRequiredError();
    this.authorization.requireAdmin(userId);
  }
}
