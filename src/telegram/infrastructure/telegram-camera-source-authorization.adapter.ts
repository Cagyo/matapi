import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { users } from '../../database/schema';
import { CameraSourceAdminRequiredError } from '../../camera/domain/errors/camera-source-admin-required.error';
import type { CameraSourceAuthorizationPort } from '../../camera/domain/ports/camera-source-authorization.port';
import type { Role } from '../domain/role';

const ADMIN: Role = 'admin';

/**
 * Reads the actor's role straight from SQLite on every call. Nothing is cached:
 * the middleware-resolved identity may be older than the mutation it guards, so
 * a member demoted between the pre-probe check and the final fence is denied by
 * the second call.
 */
@Injectable()
export class TelegramCameraSourceAuthorizationAdapter implements CameraSourceAuthorizationPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  requireAdmin(userId: number): void {
    const row = this.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.telegramId, userId))
      .get();
    if (row?.role !== ADMIN) throw new CameraSourceAdminRequiredError();
  }
}
