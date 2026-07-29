import type { DriveConnection } from "../../domain/drive-connection.entity";

export const DRIVE_ACCOUNT = Symbol("DRIVE_ACCOUNT");

export interface DriveAccountIdentity {
  permissionId: string;
  email: string | null;
  displayName: string | null;
}

export interface DriveQuota {
  limitBytes: number | null;
  usageBytes: number;
  usageInDriveBytes: number;
  usageInDriveTrashBytes: number;
}

export interface ManagedDriveFolders {
  rootId: string;
  motionId: string;
  backupsId: string;
}

/** Provider-neutral account and managed-folder boundary for one Drive generation. */
export interface DriveAccountPort {
  resolveAccount(connection: DriveConnection, signal: AbortSignal): Promise<DriveAccountIdentity>;
  readQuota(connection: DriveConnection, signal: AbortSignal): Promise<DriveQuota>;
  resolveManagedFolders(connection: DriveConnection, signal: AbortSignal): Promise<ManagedDriveFolders>;
}
