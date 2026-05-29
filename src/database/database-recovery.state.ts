import { Injectable } from '@nestjs/common';
import { DbRecovery } from './integrity';

export const DATABASE_RECOVERY_STATE = Symbol('DATABASE_RECOVERY_STATE');

/**
 * Process-lifetime holder for the boot-time database recovery outcome
 * (spec 23). Written once by the SQLite factory and read by the boot
 * notification so admins learn the database was restored or recreated.
 */
@Injectable()
export class DatabaseRecoveryState {
  recovery: DbRecovery = null;
}
