import { sql } from 'drizzle-orm';
import { check, sqliteTable, text, integer, index, primaryKey, type AnySQLiteColumn, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { DEFAULT_LOCALE } from '../telegram/domain/locale';
import type { LiveSourceSettings } from '../camera/domain/live-source.entity';

// ─── Sensors ───
export const sensors = sqliteTable('sensors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type').notNull(), // 'digital' | 'uart' | 'mqtt' | 'camera'
  config: text('config', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  debounceMs: integer('debounce_ms').default(10000),
  severity: text('severity').default('info'), // 'info' | 'warning' | 'critical'
  lastValue: text('last_value'),
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

// ─── Sensors Archive ───
export const sensorsArchive = sqliteTable('sensors_archive', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config', { mode: 'json' }),
  debounceMs: integer('debounce_ms'),
  severity: text('severity'),
  lastValue: text('last_value'),
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

// ─── Events ───
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sensorId: text('sensor_id'),
    type: text('type').notNull(), // 'state_change' | 'threshold' | 'motion' | 'system'
    payload: text('payload', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    sentAt: integer('sent_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_events_unsent').on(table.sentAt),
    index('idx_events_sensor_time').on(table.sensorId, table.createdAt),
  ],
);

// ─── Sensor Logs ───
export const sensorLogs = sqliteTable(
  'sensor_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sensorId: text('sensor_id'),
    level: text('level').notNull(),
    message: text('message').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp' }),
  },
  (table) => [index('idx_sensor_logs_sensor_time').on(table.sensorId, table.timestamp)],
);

// ─── Users ───
export const users = sqliteTable('users', {
  telegramId: integer('telegram_id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default('user'),
  locale: text('locale').notNull().default(DEFAULT_LOCALE),
  muted: integer('muted', { mode: 'boolean' }).default(false),
  // Timed non-critical pause deadline (1/4/8h). `null` = no timed pause active.
  // Legacy `muted = true` remains an indefinite pause until Resume clears it.
  nonCriticalPausedUntil: integer('non_critical_paused_until', { mode: 'timestamp' }),
  // Compare-and-swap guard for pause/resume/undo mutations; every state change
  // to muted or nonCriticalPausedUntil increments it, superseding stale receipts.
  notificationPauseRevision: integer('notification_pause_revision')
    .notNull()
    .default(0),
  quietStart: text('quiet_start'),
  quietEnd: text('quiet_end'),
  createdBy: integer('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

// ─── User-Sensor Mutes ───
export const userSensorMutes = sqliteTable(
  'user_sensor_mutes',
  {
    userId: integer('user_id').references(() => users.telegramId),
    sensorId: text('sensor_id'),
  },
  (table) => [uniqueIndex('idx_user_sensor_mute').on(table.userId, table.sensorId)],
);

// ─── Notification Pause Receipts ───
// One per timed global-pause application, enabling revision-safe Undo. Only the
// newest receipt for a user is undoable; retention is capped per user in the
// repository. `expiresAt` equals the applied deadline for a global pause but is
// kept as a first-class column because future action types have independent
// Undo windows.
export const notificationPauseReceipts = sqliteTable(
  'notification_pause_receipts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    previousPausedUntil: integer('previous_paused_until', { mode: 'timestamp' }),
    appliedPausedUntil: integer('applied_paused_until', { mode: 'timestamp' }).notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('idx_notification_pause_receipts_user_id').on(table.userId, table.id),
  ],
);

// ─── Authoritative Home Sessions ───
// Active and pending Home render identities are kept together so their CAS
// transitions can be committed atomically per Telegram user/chat pair.
export const homeSessions = sqliteTable(
  'home_sessions',
  {
    userId: integer('user_id').notNull().references(() => users.telegramId, { onDelete: 'cascade' }),
    chatId: integer('chat_id').notNull(),
    activeMessageId: integer('active_message_id'),
    activeToken: text('active_token'),
    activeRevision: integer('active_revision'),
    activeView: text('active_view'),
    activeSensorPage: integer('active_sensor_page'),
    activeViewPayload: text('active_view_payload'),
    // Keep the raw SQLite value here so the Home session adapter can reject
    // non-canonical persisted booleans instead of silently coercing them.
    activeChecking: integer('active_checking'),
    pendingKind: text('pending_kind'),
    pendingMessageId: integer('pending_message_id'),
    pendingToken: text('pending_token'),
    pendingRevision: integer('pending_revision'),
    pendingView: text('pending_view'),
    pendingSensorPage: integer('pending_sensor_page'),
    pendingViewPayload: text('pending_view_payload'),
    pendingChecking: integer('pending_checking'),
    pendingExpiresAt: integer('pending_expires_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId] }),
    index('idx_home_sessions_pending_expiry').on(table.pendingExpiresAt),
  ],
);

// ─── Home Action Receipts ───
// Current receipt selection is separate from receipt identity. Replacements
// demote the old current row so in-flight work can finish against its exact ID.
export const homeActionReceipts = sqliteTable(
  'home_action_receipts',
  {
    userId: integer('user_id').notNull().references(() => users.telegramId, { onDelete: 'cascade' }),
    chatId: integer('chat_id').notNull(),
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    /** `1` for the sole current receipt; `NULL` keeps historical rows unique-safe. */
    currentSlot: integer('current_slot').default(1),
    sessionToken: text('session_token'),
    status: text('status').notNull(),
    payload: text('payload').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId, table.kind, table.id] }),
    uniqueIndex('uq_home_action_receipts_current')
      .on(table.userId, table.chatId, table.kind, table.currentSlot),
    index('idx_home_action_receipts_identity').on(table.userId, table.chatId, table.kind, table.id),
  ],
);

// ─── Invite Codes ───
export const inviteCodes = sqliteTable('invite_codes', {
  code: text('code').primaryKey(),
  role: text('role').notNull().default('user'),
  createdBy: integer('created_by').references(() => users.telegramId),
  usedBy: integer('used_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  usedAt: integer('used_at', { mode: 'timestamp' }),
});

// ─── Cameras ───
export const cameras = sqliteTable('cameras', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type').notNull(),
  config: text('config', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  /**
   * Canonical form of `name` (see `cameraNameKey`), authoritative for logical
   * name uniqueness. Nullable only for rows predating the column, until the
   * one-time transactional backfill claims a key for each of them.
   */
  nameKey: text('name_key').unique(),
});

// ─── Camera Live Sources ───
export const cameraLiveSources = sqliteTable('camera_live_sources', {
  cameraId: text('camera_id')
    .primaryKey()
    .references(() => cameras.id, { onDelete: 'cascade' }),
  normalizedUrl: text('normalized_url').notNull(),
  settings: text('settings', { mode: 'json' })
    .$type<LiveSourceSettings>()
    .notNull(),
  ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /**
   * Compare-and-swap authority for source edits, written only by the
   * source-configuration transaction that owns it. Ordinary source writes
   * deliberately leave it alone, so a reader holding a revision must re-read it
   * inside the transaction that swaps it.
   */
  revision: integer('revision').notNull().default(0),
  /**
   * Unix epoch **milliseconds** when the stored source last passed a probe, or
   * null when unverified — same unit as `createdAt`/`updatedAt` above, so
   * `verified_at < updated_at` compares two like quantities.
   */
  verifiedAt: integer('verified_at'),
  /** Digest of the RTSP network policy in force at that verification. */
  policyDigest: text('policy_digest'),
});

export const cameraLiveCredentials = sqliteTable('camera_live_credentials', {
  cameraId: text('camera_id')
    .primaryKey()
    .references(() => cameraLiveSources.cameraId, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  authTag: text('auth_tag').notNull(),
  keyVersion: integer('key_version').notNull(),
});

// ─── Google Drive connection generations ───
// A nullable slot value makes a SQLite unique index enforce a single live
// generation and a single OAuth setup workflow without retaining a historical
// row in either slot.
export const driveConnections = sqliteTable(
  'drive_connections',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id').notNull(),
    status: text('status').notNull(),
    revision: integer('revision').notNull(),
    clientIdHash: text('client_id_hash').notNull(),
    clientEnvelope: text('client_envelope'),
    tokenEnvelope: text('token_envelope'),
    currentSlot: integer('current_slot'),
    stagedSlot: integer('staged_slot'),
    permissionId: text('permission_id'),
    email: text('email'),
    displayName: text('display_name'),
    rootFolderId: text('root_folder_id'),
    motionFolderId: text('motion_folder_id'),
    backupsFolderId: text('backups_folder_id'),
    adminUserId: integer('admin_user_id'),
    chatId: integer('chat_id'),
    workflowReceiptId: text('workflow_receipt_id'),
    workflowExpiresAt: integer('workflow_expires_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    activatedAt: integer('activated_at'),
    retiredAt: integer('retired_at'),
    errorCode: text('error_code'),
    alertCooldowns: text('alert_cooldowns', { mode: 'json' }),
    quotaReclamationStartedAt: integer('quota_reclamation_started_at'),
    quotaReclaimedAt: integer('quota_reclaimed_at'),
    quotaReclamationErrorCode: text('quota_reclamation_error_code'),
  },
  (table) => [
    uniqueIndex('uq_drive_connections_current_slot').on(table.currentSlot),
    uniqueIndex('uq_drive_connections_staged_slot').on(table.stagedSlot),
    index('idx_drive_connections_staged_expiry').on(table.stagedSlot, table.workflowExpiresAt),
    check('drive_connections_status_check', sql`${table.status} in ('staged', 'active', 'reauth_required', 'retiring', 'retired_unmanaged', 'disconnecting', 'disconnected')`),
    check('drive_connections_revision_check', sql`${table.revision} >= 0`),
    check('drive_connections_current_slot_check', sql`${table.currentSlot} is null or ${table.currentSlot} = 1`),
    check('drive_connections_staged_slot_check', sql`${table.stagedSlot} is null or ${table.stagedSlot} = 1`),
    check('drive_connections_slot_status_check', sql`(
      (${table.status} = 'staged' and ${table.stagedSlot} = 1 and ${table.currentSlot} is null)
      or
      (${table.status} in ('active', 'reauth_required') and ${table.currentSlot} = 1 and ${table.stagedSlot} is null)
      or
      (${table.status} in ('retiring', 'retired_unmanaged', 'disconnecting', 'disconnected') and ${table.currentSlot} is null and ${table.stagedSlot} is null)
    )`),
  ],
);

// ─── Durable Google Drive archive manifest ───
// Artifacts identify an immutable local source. Attempts are append-only so a
// replacement remote object never erases the audit trail of its predecessor.
export const archiveArtifacts = sqliteTable(
  'archive_artifacts',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id').notNull(),
    kind: text('kind').notNull(),
    sourceIdentity: text('source_identity').notNull(),
    trustedPath: text('trusted_path').notNull(),
    relativePath: text('relative_path').notNull(),
    size: integer('size').notNull(),
    mtimeNs: text('mtime_ns').notNull(),
    sourceTimeMs: integer('source_time_ms').notNull(),
    sha256: text('sha256').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    state: text('state').notNull(),
    currentVerifiedAttemptId: text('current_verified_attempt_id').references((): AnySQLiteColumn => driveObjectAttempts.id),
    admissionState: text('admission_state').notNull().default('ready'),
    motionDayPath: text('motion_day_path'),
    admissionNextAt: integer('admission_next_at').notNull().default(0),
    admissionErrorCode: text('admission_error_code'),
    admissionRevision: integer('admission_revision').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    localDeletedAt: integer('local_deleted_at'),
    revision: integer('revision').notNull(),
  },
  (table) => [
    uniqueIndex('uq_archive_artifacts_source_fingerprint').on(table.sourceFingerprint),
    uniqueIndex('uq_archive_artifacts_current_verified_attempt').on(table.currentVerifiedAttemptId),
    index('idx_archive_artifacts_kind_created').on(table.kind, table.createdAt),
    check('archive_artifacts_kind_check', sql`${table.kind} in ('motion_video', 'database_backup')`),
    check('archive_artifacts_state_check', sql`${table.state} in ('stabilizing', 'pending', 'verified', 'local_missing', 'superseded')`),
    check('archive_artifacts_revision_check', sql`${table.revision} >= 0`),
    check('archive_artifacts_size_check', sql`${table.size} >= 0`),
    check('archive_artifacts_verified_check', sql`(${table.state} = 'verified' and ${table.currentVerifiedAttemptId} is not null) or (${table.state} != 'verified' and ${table.currentVerifiedAttemptId} is null)`),
  ],
);

export const driveMotionFolderReservations = sqliteTable(
  'drive_motion_folder_reservations',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id').notNull(),
    generationId: text('generation_id').notNull(),
    normalizedPath: text('normalized_path').notNull(),
    level: text('level').notNull(),
    segmentName: text('segment_name').notNull(),
    folderId: text('folder_id').notNull(),
    parentFolderId: text('parent_folder_id').notNull(),
    state: text('state').notNull(),
    currentSlot: integer('current_slot'),
    revision: integer('revision').notNull(),
    errorCode: text('error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    verifiedAt: integer('verified_at'),
  },
  (table) => [
    uniqueIndex('uq_drive_motion_folder_current_path')
      .on(table.generationId, table.normalizedPath)
      .where(sql`${table.currentSlot} = 1`),
    uniqueIndex('uq_drive_motion_folder_id').on(table.folderId),
    check('drive_motion_folder_state_check', sql`${table.state} in ('reserved','verified','missing','detached','conflict','superseded')`),
    check('drive_motion_folder_slot_check', sql`${table.currentSlot} is null or ${table.currentSlot} = 1`),
  ],
);

export const archiveProviderState = sqliteTable(
  'archive_provider_state',
  {
    id: integer('id').primaryKey(),
    revision: integer('revision').notNull(),
    generationId: text('generation_id'),
    operationClass: text('operation_class'),
    failureClass: text('failure_class'),
    failureStreak: integer('failure_streak').notNull().default(0),
    cooldownUntil: integer('cooldown_until'),
    blockReason: text('block_reason'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    check('archive_provider_state_singleton_check', sql`${table.id} = 1`),
    check('archive_provider_state_revision_check', sql`${table.revision} >= 0`),
    check('archive_provider_state_failure_streak_check', sql`${table.failureStreak} >= 0`),
  ],
);

export const driveObjectAttempts = sqliteTable(
  'drive_object_attempts',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull().references(() => archiveArtifacts.id),
    generationId: text('generation_id').notNull(),
    remoteFileId: text('remote_file_id').notNull(),
    parentId: text('parent_id').notNull(),
    reservedAt: integer('reserved_at').notNull(),
    state: text('state').notNull(),
    revision: integer('revision').notNull(),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    sessionCiphertext: text('session_ciphertext'),
    sessionNonce: text('session_nonce'),
    sessionAuthTag: text('session_auth_tag'),
    sessionKeyVersion: integer('session_key_version'),
    sessionFormatVersion: integer('session_format_version'),
    sessionCreatedAt: integer('session_created_at'),
    sessionExpiresAt: integer('session_expires_at'),
    confirmedOffset: integer('confirmed_offset'),
    errorCode: text('error_code'),
    detachedReason: text('detached_reason'),
    missingReason: text('missing_reason'),
    uploadedAt: integer('uploaded_at'),
    verifiedAt: integer('verified_at'),
    deletedAt: integer('deleted_at'),
    verifiedName: text('verified_name'),
    verifiedMimeType: text('verified_mime_type'),
    verifiedSize: integer('verified_size'),
    verifiedSha256: text('verified_sha256'),
    verifiedMd5: text('verified_md5'),
    verifiedCreatedTime: integer('verified_created_time'),
    verifiedHeadRevisionId: text('verified_head_revision_id'),
    verifiedVersion: text('verified_version'),
    verifiedOwnedByMe: integer('verified_owned_by_me', { mode: 'boolean' }),
    verifiedCanDelete: integer('verified_can_delete', { mode: 'boolean' }),
    verifiedTrashed: integer('verified_trashed', { mode: 'boolean' }),
    verifiedAppProperties: text('verified_app_properties'),
    verifiedSharing: text('verified_sharing'),
    verifiedWebViewLink: text('verified_web_view_link'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_drive_object_attempts_remote_file_id').on(table.remoteFileId),
    index('idx_drive_object_attempts_queue').on(table.state, table.nextAttemptAt, table.retryCount, table.createdAt),
    index('idx_drive_object_attempts_lease_expiry').on(table.leaseExpiresAt),
    index('idx_drive_object_attempts_generation').on(table.generationId),
    index('idx_drive_object_attempts_artifact').on(table.artifactId, table.createdAt),
    check('drive_object_attempts_state_check', sql`${table.state} in ('pending', 'uploading', 'retryable', 'verified', 'missing', 'detached', 'conflict', 'abandoned', 'deleted')`),
    check('drive_object_attempts_revision_check', sql`${table.revision} >= 0`),
    check('drive_object_attempts_lease_check', sql`(${table.leaseOwner} is null and ${table.leaseExpiresAt} is null) or (${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)`),
    check('drive_object_attempts_session_check', sql`(${table.sessionCiphertext} is null and ${table.sessionNonce} is null and ${table.sessionAuthTag} is null and ${table.sessionKeyVersion} is null and ${table.sessionFormatVersion} is null and ${table.sessionCreatedAt} is null and ${table.sessionExpiresAt} is null and ${table.confirmedOffset} is null) or (${table.sessionCiphertext} is not null and ${table.sessionNonce} is not null and ${table.sessionAuthTag} is not null and ${table.sessionKeyVersion} is not null and ${table.sessionFormatVersion} = 1 and ${table.sessionCreatedAt} is not null and ${table.sessionExpiresAt} is not null and ${table.confirmedOffset} is not null)`),
    check('drive_object_attempts_verified_check', sql`${table.state} != 'verified' or (${table.verifiedAt} is not null and ${table.verifiedName} is not null and ${table.verifiedMimeType} is not null and ${table.verifiedSize} is not null and ${table.verifiedSha256} is not null and ${table.verifiedCreatedTime} is not null and ${table.verifiedHeadRevisionId} is not null and ${table.verifiedVersion} is not null and ${table.verifiedOwnedByMe} is not null and ${table.verifiedCanDelete} is not null and ${table.verifiedTrashed} is not null and ${table.verifiedAppProperties} is not null and ${table.verifiedSharing} is not null)`),
  ],
);

export const archiveSchedulerState = sqliteTable(
  'archive_scheduler_state',
  {
    id: integer('id').primaryKey(),
    revision: integer('revision').notNull(),
    backupLeaseOwner: text('backup_lease_owner'),
    backupLeaseExpiresAt: integer('backup_lease_expires_at'),
    lastBackupSuccessMs: integer('last_backup_success_ms'),
    lastUploadSuccessMs: integer('last_upload_success_ms'),
    lastReconcileSuccessMs: integer('last_reconcile_success_ms'),
    lastCleanupSuccessMs: integer('last_cleanup_success_ms'),
    lastMotionTraversalSuccessMs: integer('last_motion_traversal_success_ms'),
    lastArtifactRegistrationSuccessMs: integer('last_artifact_registration_success_ms'),
  },
  (table) => [
    check('archive_scheduler_state_singleton_check', sql`${table.id} = 1`),
    check('archive_scheduler_state_revision_check', sql`${table.revision} >= 0`),
    check('archive_scheduler_state_lease_check', sql`(${table.backupLeaseOwner} is null and ${table.backupLeaseExpiresAt} is null) or (${table.backupLeaseOwner} is not null and ${table.backupLeaseExpiresAt} is not null)`),
  ],
);

// ─── Motion Events ───
export const motionEvents = sqliteTable(
  'motion_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cameraId: text('camera_id').references(() => cameras.id),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    endedAt: integer('ended_at', { mode: 'timestamp' }),
    videoPath: text('video_path'),
    snapshotPath: text('snapshot_path'),
    archiveArtifactId: text('archive_artifact_id').references(() => archiveArtifacts.id),
    localDeleted: integer('local_deleted', { mode: 'boolean' }).default(false),
  },
  (table) => [
    index('idx_motion_camera_time').on(table.cameraId, table.startedAt),
    index('idx_motion_archive_artifact').on(table.archiveArtifactId),
  ],
);

// ─── Features ───
export const features = sqliteTable('features', {
  name: text('name').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).default(false),
  installed: integer('installed', { mode: 'boolean' }).default(false),
  config: text('config', { mode: 'json' }),
  attentionReason: text('attention_reason'),
});

export const featureInstallJobs = sqliteTable(
  'feature_install_jobs',
  {
    id: text('id').primaryKey(),
    featureName: text('feature_name').notNull().references(() => features.name),
    status: text('status').notNull(),
    activeSlot: integer('active_slot'),
    /** Legacy rows predate the reinstall action, so they default to a plain install. */
    operation: text('operation').notNull().default('install'),
    requestedByUserId: integer('requested_by_user_id').notNull(),
    requestedInChatId: integer('requested_in_chat_id').notNull(),
    workflowReceiptId: text('workflow_receipt_id').notNull(),
    previousInstalled: integer('previous_installed', { mode: 'boolean' }).notNull(),
    previousEnabled: integer('previous_enabled', { mode: 'boolean' }).notNull(),
    restartScope: text('restart_scope'),
    /** `<linux-boot-id>:<proc-self-start-ticks>` of the process that dispatched the restart. */
    restartDispatchIdentity: text('restart_dispatch_identity'),
    failureCode: text('failure_code'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('idx_feature_install_jobs_active_slot').on(table.activeSlot),
    index('idx_feature_install_jobs_feature_time').on(table.featureName, table.createdAt),
    index('idx_feature_install_jobs_receipt').on(table.workflowReceiptId),
    check('feature_install_jobs_status_check', sql`${table.status} in ('queued', 'running', 'awaiting-restart', 'succeeded', 'failed')`),
    check('feature_install_jobs_operation_check', sql`${table.operation} in ('install', 'reinstall')`),
    check('feature_install_jobs_active_slot_check', sql`(
      (${table.status} in ('queued', 'running', 'awaiting-restart') and ${table.activeSlot} is 1)
      or (${table.status} in ('succeeded', 'failed') and ${table.activeSlot} is null)
    )`),
    check('feature_install_jobs_restart_scope_check', sql`${table.restartScope} is null or ${table.restartScope} in ('worker', 'supervisor', 'host')`),
  ],
);

// ─── System Metadata ───
export const systemMeta = sqliteTable('system_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});
