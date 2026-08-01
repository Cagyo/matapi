export const ARCHIVE_ADMIN_ALERT = Symbol('ARCHIVE_ADMIN_ALERT');

export interface ArchiveAdminAlert {
  artifactId: string;
  reason: 'remote_missing_without_local_source' | 'remote_detached';
}

/** Required at-least-once durable handoff for administrator-facing archive alerts. */
export interface ArchiveAdminAlertPort {
  alert(alert: ArchiveAdminAlert): Promise<void>;
}
