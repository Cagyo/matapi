import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { DriveQuota } from './drive-account.port';

export const DRIVE_QUOTA_PROBE = Symbol('DRIVE_QUOTA_PROBE');

/** Direct live quota read reserved for a CAS-claimed provider recovery probe. */
export interface DriveQuotaProbePort {
  readQuota(connection: DriveConnection, signal: AbortSignal): Promise<DriveQuota>;
}
