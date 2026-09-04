import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  archiveArtifacts,
  driveMotionFolderReservations,
  driveObjectAttempts,
} from '../../../database/schema';

export interface ArchiveSqlQuery {
  sql: string;
  params: readonly unknown[];
}

interface AdmissionQueueQueryInput {
  generationId: string;
  nowMs: number;
  limit: number;
}

interface AttemptDeadlineQueryInput {
  generationId: string;
  nowMs: number;
}

interface BlockedPrefixQueryInput {
  generationId: string;
  dayPath: string;
}

const dialect = new SQLiteSyncDialect();

/**
 * Selects bounded, due Motion artifacts that have no immutable attempt and no
 * blocked current date-folder ancestor.
 */
export function admissionQueueQuery(input: AdmissionQueueQueryInput): ArchiveSqlQuery {
  return compile(sql`
    select
      ${archiveArtifacts.id} as "id",
      ${archiveArtifacts.installationId} as "installationId",
      ${archiveArtifacts.kind} as "kind",
      ${archiveArtifacts.sourceIdentity} as "sourceIdentity",
      ${archiveArtifacts.trustedPath} as "trustedPath",
      ${archiveArtifacts.relativePath} as "relativePath",
      ${archiveArtifacts.size} as "size",
      ${archiveArtifacts.mtimeNs} as "mtimeNs",
      ${archiveArtifacts.sourceTimeMs} as "sourceTimeMs",
      ${archiveArtifacts.sha256} as "sha256",
      ${archiveArtifacts.sourceFingerprint} as "sourceFingerprint",
      ${archiveArtifacts.state} as "state",
      ${archiveArtifacts.currentVerifiedAttemptId} as "currentVerifiedAttemptId",
      ${archiveArtifacts.admissionState} as "admissionState",
      ${archiveArtifacts.motionDayPath} as "motionDayPath",
      ${archiveArtifacts.admissionNextAt} as "admissionNextAt",
      ${archiveArtifacts.admissionErrorCode} as "admissionErrorCode",
      ${archiveArtifacts.admissionRevision} as "admissionRevision",
      ${archiveArtifacts.createdAt} as "createdAt",
      ${archiveArtifacts.updatedAt} as "updatedAt",
      ${archiveArtifacts.localDeletedAt} as "localDeletedAt",
      ${archiveArtifacts.revision} as "revision"
    from ${archiveArtifacts} indexed by idx_archive_artifacts_admission_queue
    where ${archiveArtifacts.kind} = 'motion_video'
      and ${archiveArtifacts.state} = 'pending'
      and ${archiveArtifacts.admissionState} in ('ready', 'retryable')
      and ${archiveArtifacts.admissionNextAt} <= ${input.nowMs}
      and not exists (
        select 1
        from ${driveObjectAttempts}
          indexed by idx_drive_attempts_artifact_generation_state
        where ${driveObjectAttempts.artifactId} = ${archiveArtifacts.id}
      )
      and (
        ${archiveArtifacts.motionDayPath} is null
        or not ${blockedPrefixExists(input.generationId, archiveArtifacts.motionDayPath)}
      )
    order by ${archiveArtifacts.createdAt}, ${archiveArtifacts.id}
    limit ${input.limit}
  `);
}

/** Returns the next future transfer deadline in the selected generation. */
export function attemptDeadlineQuery(input: AttemptDeadlineQueryInput): ArchiveSqlQuery {
  return compile(sql`
    select min(${driveObjectAttempts.nextAttemptAt}) as "value"
    from ${driveObjectAttempts} indexed by idx_drive_attempts_generation_queue
    where ${driveObjectAttempts.generationId} = ${input.generationId}
      and ${driveObjectAttempts.state} in ('pending', 'retryable')
      and ${driveObjectAttempts.nextAttemptAt} > ${input.nowMs}
  `);
}

/**
 * Computes the public queue projection as one row. Historical attempts stay in
 * SQL, and retryable artifacts are de-duplicated before crossing the adapter.
 */
export function queueStatusAggregateQuery(
  generationId: string,
  nowMs: number,
): ArchiveSqlQuery {
  return compile(sql`
    select
      (
        select count(*)
        from ${archiveArtifacts} indexed by idx_archive_artifacts_admission_queue
        where ${queuedMotionPredicate()}
      ) as "queuedVideos",
      (
        select count(distinct artifact_id)
        from (
          select ${archiveArtifacts.id} as artifact_id
          from ${archiveArtifacts} indexed by idx_archive_artifacts_admission_queue
          where ${queuedMotionPredicate()}
            and ${archiveArtifacts.admissionState} = 'retryable'
          union all
          select ${driveObjectAttempts.artifactId} as artifact_id
          from ${driveObjectAttempts} indexed by idx_drive_attempts_generation_queue
          inner join ${archiveArtifacts}
            on ${archiveArtifacts.id} = ${driveObjectAttempts.artifactId}
          where ${driveObjectAttempts.generationId} = ${generationId}
            and ${driveObjectAttempts.state} = 'retryable'
            and ${queuedMotionPredicate()}
        ) as retryable_artifacts
      ) as "retryableVideos",
      (
        select min(${archiveArtifacts.createdAt})
        from ${archiveArtifacts} indexed by idx_archive_artifacts_admission_queue
        where ${queuedMotionPredicate()}
      ) as "oldestQueuedVideoAtMs",
      case
        when exists (
          select 1
          from ${archiveArtifacts} indexed by idx_archive_artifacts_admission_queue
          where ${queuedMotionPredicate()}
            and ${archiveArtifacts.motionDayPath} is not null
            and ${blockedPrefixExists(generationId, archiveArtifacts.motionDayPath)}
          limit 1
        )
        and not exists (
          select 1
          from ${archiveArtifacts} indexed by idx_archive_artifacts_admission_queue
          where ${queuedMotionPredicate()}
            and ${dueArtifactPredicate(generationId, nowMs)}
            and (
              ${archiveArtifacts.motionDayPath} is null
              or not ${blockedPrefixExists(generationId, archiveArtifacts.motionDayPath)}
            )
          limit 1
        )
        then 1
        else 0
      end as "branchBlocked"
  `);
}

/** Probes whether a concrete Motion day has an unhealthy current ancestor. */
export function blockedPrefixQuery(input: BlockedPrefixQueryInput): ArchiveSqlQuery {
  return compile(sql`
    select case when ${blockedPrefixExists(input.generationId, input.dayPath)}
      then 1 else 0 end as "blocked"
  `);
}

function queuedMotionPredicate(): SQL {
  return sql`${archiveArtifacts.kind} = 'motion_video'
    and ${archiveArtifacts.state} = 'pending'
    and ${archiveArtifacts.admissionState} in ('ready', 'retryable')`;
}

function dueArtifactPredicate(generationId: string, nowMs: number): SQL {
  return sql`(
    (
      not exists (
        select 1
        from ${driveObjectAttempts}
          indexed by idx_drive_attempts_artifact_generation_state
        where ${driveObjectAttempts.artifactId} = ${archiveArtifacts.id}
      )
      and ${archiveArtifacts.admissionNextAt} <= ${nowMs}
    )
    or exists (
      select 1
      from ${driveObjectAttempts}
        indexed by idx_drive_attempts_artifact_generation_state
      where ${driveObjectAttempts.artifactId} = ${archiveArtifacts.id}
        and ${driveObjectAttempts.generationId} = ${generationId}
        and ${driveObjectAttempts.state} in ('pending', 'retryable')
        and ${driveObjectAttempts.nextAttemptAt} <= ${nowMs}
    )
  )`;
}

function blockedPrefixExists(generationId: string, dayPath: SQLWrapper | string): SQL {
  return sql`exists (
    select 1
    from ${driveMotionFolderReservations}
      indexed by idx_drive_motion_folder_current_health
    where ${driveMotionFolderReservations.generationId} = ${generationId}
      and ${driveMotionFolderReservations.currentSlot} = 1
      and ${driveMotionFolderReservations.state} in ('detached', 'conflict')
      and ${driveMotionFolderReservations.normalizedPath} in (
        substr(${dayPath}, 1, 4),
        substr(${dayPath}, 1, 7),
        ${dayPath}
      )
  )`;
}

function compile(query: SQL): ArchiveSqlQuery {
  const compiled = dialect.sqlToQuery(query);
  return { sql: compiled.sql, params: compiled.params };
}
