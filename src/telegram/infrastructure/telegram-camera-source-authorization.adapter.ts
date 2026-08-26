import { Inject, Injectable, Logger } from '@nestjs/common';
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
 *
 * An unreadable table denies too — a busy or closed database cannot answer
 * "is this actor still an admin?", and the only safe answer to that is no. The
 * cause is logged, never returned, so the domain sees one verdict type.
 *
 * Under `BOT_MODE=mock` nothing ever writes the `users` table, so this denies
 * every actor in development; that is the fail-closed direction, not a fault.
 */
@Injectable()
export class TelegramCameraSourceAuthorizationAdapter implements CameraSourceAuthorizationPort {
  private readonly logger = new Logger(TelegramCameraSourceAuthorizationAdapter.name);

  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  requireAdmin(userId: number): void {
    let role: string | undefined;
    try {
      role = this.db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.telegramId, userId))
        .get()?.role;
    } catch (error) {
      // No actor identity in the log line: the failure is about the database.
      this.logger.warn(
        `Camera source authorization lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new CameraSourceAdminRequiredError();
    }
    if (role !== ADMIN) throw new CameraSourceAdminRequiredError();
  }
}
