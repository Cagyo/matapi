import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { ConfigModule } from '../config/config.module';
import { loadDefaults } from '../config/config.loader';
import {
  TIMEZONE_OPTIONS,
  type TimezoneOptions,
} from '../config/application/ports/timezone-options.port';
import { DatabaseModule } from '../database/database.module';
import {
  DATABASE_BACKUP_SNAPSHOT,
  type DatabaseBackupSnapshotPort,
} from '../database/application/ports/database-backup-snapshot.port';
import { EventModule } from '../events/event.module';
import { EventQueueService } from '../events/application/event-queue.service';
import { CLOCK, type ClockPort } from '../events/domain/ports/clock.port';
import { SystemModule } from '../system/system.module';
import { BootRecoveryService } from '../system/application/boot-recovery.service';
import {
  CLOCK_SYNC_PROBE,
  type ClockSyncProbePort,
} from '../system/domain/ports/clock-sync.port';
import {
  ArchiveRuntimeLifecycleService,
} from './application/archive-runtime-lifecycle.service';
import { ArchiveRemoteMutationLockService } from './application/archive-remote-mutation-lock.service';
import { ArchiveAdminAlertService } from './application/archive-admin-alert.service';
import {
  ArchiveSchedulerHooksService,
  ArchiveSchedulerService,
} from './application/archive-scheduler.service';
import { ArchiveTransferSemaphoreService } from './application/archive-transfer-semaphore.service';
import {
  DriveAuthorizationOutcomeRegistrationService,
  DriveAuthorizationPollingService,
} from './application/drive-authorization-polling.service';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
} from './application/ports/archive-artifact-repository.port';
import {
  ARCHIVE_ADMIN_ALERT,
  type ArchiveAdminAlertPort,
} from './application/ports/archive-admin-alert.port';
import { ARCHIVE_REGISTRATION } from './application/ports/archive-registration.port';
import { ARCHIVE_VERIFICATION } from './application/ports/archive-verification.port';
import { ARCHIVE_SECRET_CIPHER } from './application/ports/archive-secret-cipher.port';
import {
  ARCHIVE_CLOCK,
  type ArchiveClockPort,
} from './application/ports/archive-clock.port';
import {
  ARCHIVE_RETENTION,
  type ArchiveRetentionPort,
} from './application/ports/archive-retention.port';
import { DRIVE_ACCOUNT, type DriveAccountPort } from './application/ports/drive-account.port';
import { DRIVE_ARCHIVE, type DriveArchivePort } from './application/ports/drive-archive.port';
import { DRIVE_AUTHORIZATION_OUTCOME } from './application/ports/drive-authorization-outcome.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from './application/ports/drive-credential-repository.port';
import {
  DRIVE_DEVICE_AUTHORIZATION,
  type DriveDeviceAuthorizationPort,
} from './application/ports/drive-device-authorization.port';
import { BeginDriveConnectionUseCase } from './application/use-cases/begin-drive-connection.use-case';
import { CancelDriveConnectionUseCase } from './application/use-cases/cancel-drive-connection.use-case';
import { ConfirmDriveAccountUseCase } from './application/use-cases/confirm-drive-account.use-case';
import { CreateDatabaseBackupUseCase } from './application/use-cases/create-database-backup.use-case';
import { DisconnectDriveUseCase } from './application/use-cases/disconnect-drive.use-case';
import { RegisterArchiveArtifactUseCase } from './application/use-cases/register-archive-artifact.use-case';
import { ReconcileDriveUseCase } from './application/use-cases/reconcile-drive.use-case';
import { RetireDriveConnectionUseCase } from './application/use-cases/retire-drive-connection.use-case';
import { ReportDriveStatusUseCase } from './application/use-cases/report-drive-status.use-case';
import { SubmitDriveClientUseCase } from './application/use-cases/submit-drive-client.use-case';
import { VerifyArchiveArtifactUseCase } from './application/use-cases/verify-archive-artifact.use-case';
import { ApplyDriveRetentionUseCase } from './application/use-cases/apply-drive-retention.use-case';
import { DriveClockUnhealthyError } from './domain/errors/drive-clock-unhealthy.error';
import {
  ARCHIVE_UPLOAD_SOURCE,
  UploadDriveObjectAttemptUseCase,
  type ArchiveUploadSourcePort,
} from './application/use-cases/upload-drive-object-attempt.use-case';
import { GoogleDeviceAuthorizationAdapter } from './infrastructure/google/google-device-authorization.adapter';
import { GoogleDriveArchiveAdapter } from './infrastructure/google/google-drive-archive.adapter';
import { GoogleDriveConnectionAccountAdapter } from './infrastructure/google/google-drive-connection-account.adapter';
import { AesGcmArchiveSecretAdapter } from './infrastructure/persistence/aes-gcm-archive-secret.adapter';
import { DrizzleArchiveArtifactRepository } from './infrastructure/persistence/drizzle-archive-artifact.repository';
import { DrizzleDriveCredentialRepository } from './infrastructure/persistence/drizzle-drive-credential.repository';
import { FsArchiveUploadSourceAdapter } from './infrastructure/persistence/fs-archive-upload-source.adapter';
import { DurableArchiveAdminAlertAdapter } from './infrastructure/events/durable-archive-admin-alert.adapter';
import { InMemoryArchiveArtifactRepository } from './infrastructure/persistence/in-memory-archive-artifact.repository';
import { InMemoryDriveCredentialRepository } from './infrastructure/persistence/in-memory-drive-credential.repository';
import { SystemArchiveClockAdapter } from './infrastructure/system-archive-clock.adapter';
import { archiveSchedulerOptionsFromConfig } from './infrastructure/archive-scheduler-options.adapter';

const ARCHIVE_BOOT_RECOVERY_REGISTRATION = Symbol('ARCHIVE_BOOT_RECOVERY_REGISTRATION');
const ARCHIVE_REMOTE_MAINTENANCE_REGISTRATION = Symbol('ARCHIVE_REMOTE_MAINTENANCE_REGISTRATION');
const archiveMode = process.env.NODE_ENV === 'test' ? 'memory' : 'production';

/** Archive composition root. Cross-context consumers receive only ports and application services. */
@Module({
  imports: [ConfigModule, DatabaseModule, EventModule, SystemModule],
  providers: [
    {
      provide: ARCHIVE_SECRET_CIPHER,
      useFactory: () => new AesGcmArchiveSecretAdapter(
        process.env.HOME_WORKER_ARCHIVE_KEY_PATH ?? '/etc/home-worker/archive.key',
      ),
    },
    archiveMode === 'memory' ? InMemoryDriveCredentialRepository : DrizzleDriveCredentialRepository,
    {
      provide: DRIVE_CREDENTIAL_REPOSITORY,
      useExisting: archiveMode === 'memory'
        ? InMemoryDriveCredentialRepository
        : DrizzleDriveCredentialRepository,
    },
    archiveMode === 'memory' ? InMemoryArchiveArtifactRepository : DrizzleArchiveArtifactRepository,
    {
      provide: ARCHIVE_ARTIFACT_REPOSITORY,
      useExisting: archiveMode === 'memory'
        ? InMemoryArchiveArtifactRepository
        : DrizzleArchiveArtifactRepository,
    },
    RegisterArchiveArtifactUseCase,
    { provide: ARCHIVE_REGISTRATION, useExisting: RegisterArchiveArtifactUseCase },
    {
      provide: DRIVE_DEVICE_AUTHORIZATION,
      useFactory: (clock: ClockPort) => new GoogleDeviceAuthorizationAdapter({
        clock: {
          now: () => clock.now().getTime(),
          sleep: abortableSleep,
        },
      }),
      inject: [CLOCK],
    },
    GoogleDriveConnectionAccountAdapter,
    { provide: DRIVE_ACCOUNT, useExisting: GoogleDriveConnectionAccountAdapter },
    {
      provide: GoogleDriveArchiveAdapter,
      useFactory: (credentials: DriveCredentialRepositoryPort) =>
        new GoogleDriveArchiveAdapter(credentials),
      inject: [DRIVE_CREDENTIAL_REPOSITORY],
    },
    { provide: DRIVE_ARCHIVE, useExisting: GoogleDriveArchiveAdapter },
    FsArchiveUploadSourceAdapter,
    { provide: ARCHIVE_UPLOAD_SOURCE, useExisting: FsArchiveUploadSourceAdapter },
    ArchiveAdminAlertService,
    {
      provide: DurableArchiveAdminAlertAdapter,
      useFactory: (
        queue: EventQueueService,
        alerts: ArchiveAdminAlertService,
        clock: ClockPort,
      ) => new DurableArchiveAdminAlertAdapter(queue, alerts, clock),
      inject: [EventQueueService, ArchiveAdminAlertService, CLOCK],
    },
    { provide: ARCHIVE_ADMIN_ALERT, useExisting: DurableArchiveAdminAlertAdapter },
    {
      provide: ReportDriveStatusUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        repository: ArchiveArtifactRepositoryPort,
        account: DriveAccountPort,
      ) => new ReportDriveStatusUseCase(credentials, repository, account),
      inject: [DRIVE_CREDENTIAL_REPOSITORY, ARCHIVE_ARTIFACT_REPOSITORY, DRIVE_ACCOUNT],
    },
    {
      provide: VerifyArchiveArtifactUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        credentials: DriveCredentialRepositoryPort,
        drive: DriveArchivePort,
        source: ArchiveUploadSourcePort,
        lock: ArchiveRemoteMutationLockService,
      ) => new VerifyArchiveArtifactUseCase(repository, credentials, drive, source, lock),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ARCHIVE,
        ARCHIVE_UPLOAD_SOURCE,
        ArchiveRemoteMutationLockService,
      ],
    },
    { provide: ARCHIVE_VERIFICATION, useExisting: VerifyArchiveArtifactUseCase },
    {
      provide: ReconcileDriveUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        credentials: DriveCredentialRepositoryPort,
        drive: DriveArchivePort,
        source: ArchiveUploadSourcePort,
        alerts: ArchiveAdminAlertPort,
      ) => new ReconcileDriveUseCase(repository, credentials, drive, source, alerts),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ARCHIVE,
        ARCHIVE_UPLOAD_SOURCE,
        ARCHIVE_ADMIN_ALERT,
      ],
    },
    {
      provide: ArchiveTransferSemaphoreService,
      useFactory: () => new ArchiveTransferSemaphoreService(),
    },
    ArchiveRemoteMutationLockService,
    {
      provide: SystemArchiveClockAdapter,
      useFactory: (clockSync: ClockSyncProbePort) =>
        new SystemArchiveClockAdapter(clockSync),
      inject: [CLOCK_SYNC_PROBE],
    },
    { provide: ARCHIVE_CLOCK, useExisting: SystemArchiveClockAdapter },
    ArchiveSchedulerHooksService,
    DriveAuthorizationOutcomeRegistrationService,
    {
      provide: DRIVE_AUTHORIZATION_OUTCOME,
      useExisting: DriveAuthorizationOutcomeRegistrationService,
    },
    {
      provide: DriveAuthorizationPollingService,
      useFactory: (
        authorization: DriveDeviceAuthorizationPort,
        credentials: DriveCredentialRepositoryPort,
        accounts: DriveAccountPort,
        outcomes: DriveAuthorizationOutcomeRegistrationService,
      ) => new DriveAuthorizationPollingService(authorization, credentials, accounts, outcomes),
      inject: [
        DRIVE_DEVICE_AUTHORIZATION,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ACCOUNT,
        DriveAuthorizationOutcomeRegistrationService,
      ],
    },
    {
      provide: BeginDriveConnectionUseCase,
      useFactory: (clock: ClockPort) =>
        new BeginDriveConnectionUseCase(clock, archiveInstallationId),
      inject: [CLOCK],
    },
    {
      provide: SubmitDriveClientUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        authorization: DriveDeviceAuthorizationPort,
        polling: DriveAuthorizationPollingService,
        clock: ClockPort,
      ) => new SubmitDriveClientUseCase(credentials, authorization, polling, clock),
      inject: [
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_DEVICE_AUTHORIZATION,
        DriveAuthorizationPollingService,
        CLOCK,
      ],
    },
    {
      provide: ConfirmDriveAccountUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        account: DriveAccountPort,
        clock: ClockPort,
      ) => new ConfirmDriveAccountUseCase(credentials, account, clock),
      inject: [DRIVE_CREDENTIAL_REPOSITORY, DRIVE_ACCOUNT, CLOCK],
    },
    {
      provide: CancelDriveConnectionUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        polling: DriveAuthorizationPollingService,
      ) => new CancelDriveConnectionUseCase(credentials, polling),
      inject: [DRIVE_CREDENTIAL_REPOSITORY, DriveAuthorizationPollingService],
    },
    {
      provide: DisconnectDriveUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        authorization: DriveDeviceAuthorizationPort,
        polling: DriveAuthorizationPollingService,
        repository: ArchiveArtifactRepositoryPort,
        clock: ClockPort,
      ) => new DisconnectDriveUseCase(credentials, authorization, polling, repository, clock),
      inject: [
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_DEVICE_AUTHORIZATION,
        DriveAuthorizationPollingService,
        ARCHIVE_ARTIFACT_REPOSITORY,
        CLOCK,
      ],
    },
    {
      provide: RetireDriveConnectionUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        authorization: DriveDeviceAuthorizationPort,
        clock: ClockPort,
      ) => new RetireDriveConnectionUseCase(credentials, authorization, clock),
      inject: [DRIVE_CREDENTIAL_REPOSITORY, DRIVE_DEVICE_AUTHORIZATION, CLOCK],
    },
    {
      provide: CreateDatabaseBackupUseCase,
      useFactory: (
        snapshots: DatabaseBackupSnapshotPort,
        registration: RegisterArchiveArtifactUseCase,
        repository: ArchiveArtifactRepositoryPort,
        timezone: TimezoneOptions,
      ) => new CreateDatabaseBackupUseCase(
        snapshots,
        registration,
        repository,
        archiveInstallationId,
        timezone,
      ),
      inject: [
        DATABASE_BACKUP_SNAPSHOT,
        ARCHIVE_REGISTRATION,
        ARCHIVE_ARTIFACT_REPOSITORY,
        TIMEZONE_OPTIONS,
      ],
    },
    {
      provide: UploadDriveObjectAttemptUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        credentials: DriveCredentialRepositoryPort,
        drive: DriveArchivePort,
        cipher: AesGcmArchiveSecretAdapter,
        source: ArchiveUploadSourcePort,
        semaphore: ArchiveTransferSemaphoreService,
        activityGate: ArchiveRemoteMutationLockService,
      ) => new UploadDriveObjectAttemptUseCase(
        repository, credentials, drive, cipher, source, semaphore, { activityGate },
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ARCHIVE,
        ARCHIVE_SECRET_CIPHER,
        ARCHIVE_UPLOAD_SOURCE,
        ArchiveTransferSemaphoreService,
        ArchiveRemoteMutationLockService,
      ],
    },
    {
      provide: ApplyDriveRetentionUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        credentials: DriveCredentialRepositoryPort,
        account: DriveAccountPort,
        drive: DriveArchivePort,
        source: ArchiveUploadSourcePort,
        clock: ArchiveClockPort,
        lock: ArchiveRemoteMutationLockService,
      ) => new ApplyDriveRetentionUseCase(
        repository,
        credentials,
        account,
        drive,
        source,
        clock,
        lock,
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ACCOUNT,
        DRIVE_ARCHIVE,
        ARCHIVE_UPLOAD_SOURCE,
        ARCHIVE_CLOCK,
        ArchiveRemoteMutationLockService,
      ],
    },
    { provide: ARCHIVE_RETENTION, useExisting: ApplyDriveRetentionUseCase },
    {
      provide: ArchiveSchedulerService,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        backups: CreateDatabaseBackupUseCase,
        uploads: UploadDriveObjectAttemptUseCase,
        hooks: ArchiveSchedulerHooksService,
        lock: ArchiveRemoteMutationLockService,
        retention: ArchiveRetentionPort,
        clock: ClockPort,
      ) => new ArchiveSchedulerService(
        repository,
        backups,
        uploads,
        hooks,
        lock,
        retention,
        clock,
        archiveSchedulerOptionsFromConfig(loadDefaults().archive, process.env),
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        CreateDatabaseBackupUseCase,
        UploadDriveObjectAttemptUseCase,
        ArchiveSchedulerHooksService,
        ArchiveRemoteMutationLockService,
        ARCHIVE_RETENTION,
        CLOCK,
      ],
    },
    {
      provide: ArchiveRuntimeLifecycleService,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        repository: ArchiveArtifactRepositoryPort,
        retire: RetireDriveConnectionUseCase,
        polling: DriveAuthorizationPollingService,
        snapshots: DatabaseBackupSnapshotPort,
        backups: CreateDatabaseBackupUseCase,
        scheduler: ArchiveSchedulerService,
        hooks: ArchiveSchedulerHooksService,
        clock: ClockPort,
        lock: ArchiveRemoteMutationLockService,
      ) => new ArchiveRuntimeLifecycleService(
        credentials, repository, retire, polling, snapshots, backups,
        scheduler, hooks, clock, lock,
      ),
      inject: [
        DRIVE_CREDENTIAL_REPOSITORY,
        ARCHIVE_ARTIFACT_REPOSITORY,
        RetireDriveConnectionUseCase,
        DriveAuthorizationPollingService,
        DATABASE_BACKUP_SNAPSHOT,
        CreateDatabaseBackupUseCase,
        ArchiveSchedulerService,
        ArchiveSchedulerHooksService,
        CLOCK,
        ArchiveRemoteMutationLockService,
      ],
    },
    {
      provide: ARCHIVE_REMOTE_MAINTENANCE_REGISTRATION,
      useFactory: (
        hooks: ArchiveSchedulerHooksService,
        reconcile: ReconcileDriveUseCase,
        retention: ArchiveRetentionPort,
        alerts: ArchiveAdminAlertPort,
      ) => {
        hooks.registerRemoteMaintenance(async (lock, signal) => {
          await reconcile.execute({ limit: 20 }, signal, lock);
          if (signal.aborted) return;
          try {
            await retention.execute({ requiredBytes: 0 }, signal);
          } catch (error) {
            if (!(error instanceof DriveClockUnhealthyError)) throw error;
            await alerts.alert('clock-unhealthy', {
              generationId: '',
              errorCode: error.code,
            });
          }
        });
        return reconcile;
      },
      inject: [
        ArchiveSchedulerHooksService,
        ReconcileDriveUseCase,
        ARCHIVE_RETENTION,
        ARCHIVE_ADMIN_ALERT,
      ],
    },
    {
      provide: ARCHIVE_BOOT_RECOVERY_REGISTRATION,
      useFactory: (
        lifecycle: ArchiveRuntimeLifecycleService,
        bootRecovery: BootRecoveryService,
      ) => {
        bootRecovery.registerArchiveRecovery(() => lifecycle.start());
        return lifecycle;
      },
      inject: [ArchiveRuntimeLifecycleService, BootRecoveryService],
    },
  ],
  exports: [
    DRIVE_CREDENTIAL_REPOSITORY,
    ARCHIVE_ARTIFACT_REPOSITORY,
    ARCHIVE_REGISTRATION,
    ARCHIVE_VERIFICATION,
    DRIVE_DEVICE_AUTHORIZATION,
    DRIVE_ACCOUNT,
    BeginDriveConnectionUseCase,
    SubmitDriveClientUseCase,
    ConfirmDriveAccountUseCase,
    CancelDriveConnectionUseCase,
    DisconnectDriveUseCase,
    DriveAuthorizationPollingService,
    DriveAuthorizationOutcomeRegistrationService,
    ArchiveSchedulerHooksService,
    ArchiveRemoteMutationLockService,
    ARCHIVE_RETENTION,
    ArchiveRuntimeLifecycleService,
    ARCHIVE_ADMIN_ALERT,
    ArchiveAdminAlertService,
    ReportDriveStatusUseCase,
  ],
})
export class ArchiveModule {}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

function archiveInstallationId(): string {
  if (process.env.NODE_ENV === 'test') return '00000000-0000-4000-8000-000000000000';
  const direct = process.env.HOME_WORKER_INSTALLATION_ID?.trim();
  if (direct) return direct;
  return readFileSync(
    process.env.HOME_WORKER_INSTALLATION_ID_PATH ?? '/etc/home-worker/installation-id',
    'utf8',
  ).trim();
}
