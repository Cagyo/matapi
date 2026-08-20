export const ARCHIVE_ADMIN_ALERT = Symbol('ARCHIVE_ADMIN_ALERT');

export const ARCHIVE_ADMIN_ALERT_KINDS = [
  'reauthorization-required',
  'policy-rejected',
  'quota-reclamation-required',
  'remote-object-missing',
  'remote-object-detached',
  'retired-archive',
  'upload-failure-prolonged',
  'backup-failure-prolonged',
  'credential-corrupt',
  'clock-unhealthy',
  'local-disk-pressure',
  'folder-branch-unhealthy',
  'provider-cooldown-prolonged',
  'provider-capacity-blocked',
  'backlog-age-prolonged',
] as const;

export type ArchiveAdminAlertKind = (typeof ARCHIVE_ADMIN_ALERT_KINDS)[number];

export interface ArchiveAdminAlert {
  kind: ArchiveAdminAlertKind;
  generationId: string;
  artifactId?: string;
  /** Sanitized code only. Provider messages, credentials, and links never cross this port. */
  errorCode?: string;
}

export interface ArchiveAdminAlertDeliveryPort {
  send(alert: ArchiveAdminAlert): Promise<void>;
}

/** Durable, rate-limited handoff for administrator-facing archive alerts. */
export interface ArchiveAdminAlertPort {
  alert(
    kind: ArchiveAdminAlertKind,
    context: Omit<ArchiveAdminAlert, 'kind'>,
  ): Promise<void>;
}
