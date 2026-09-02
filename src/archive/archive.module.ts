import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { ConfigModule } from '../config/config.module';
import { loadDefaults } from '../config/config.loader';
import {
  TIMEZONE_OPTIONS,
  type TimezoneOptions,
} from '../config/application/ports/timezone-options.port';
import { type AppDatabase, DatabaseModule, DB } from '../database/database.module';
import {
  DATABASE_BACKUP_SNAPSHOT,
  type DatabaseBackupSnapshotPort,
} from '../database/application/ports/database-backup-snapshot.port';
import { EventModule } from '../events/event.module';
import { NotificationService } from '../events/application/notification.service';
import {
  EVENT_QUEUE_OPTIONS,
  type EventQueueOptions,
} from '../events/application/ports/event-queue-options.port';
import { CLOCK, type ClockPort } from '../events/domain/ports/clock.port';
import {
  EVENT_REPOSITORY,
  type EventRepositoryPort,
} from '../events/domain/ports/event-repository.port';
import { SystemModule } from '../system/system.module';
import { BootRecoveryService } from '../system/application/boot-recovery.service';
import {
  CLOCK_SYNC_PROBE,
  type ClockSyncProbePort,
} from '../system/domain/ports/clock-sync.port';
import {
  SYSTEM_HEALTH,
  type SystemHealthPort,
} from '../system/domain/ports/system-health.port';
import {
  ArchiveRuntimeLifecycleService,
} from './application/archive-runtime-lifecycle.service';
import { ArchiveRemoteMutationLockService } from './application/archive-remote-mutation-lock.service';
import { ArchiveAdminAlertService } from './application/archive-admin-alert.service';
import {
  ArchiveSchedulerHooksService,
  ArchiveSchedulerService,
  type ArchiveSchedulerOptions,
} from './application/archive-scheduler.service';
import { ArchiveTransferSemaphoreService } from './application/archive-transfer-semaphore.service';
import { ArchiveWakeService } from './application/archive-wake.service';
import { ArchiveProviderGateService } from './application/archive-provider-gate.service';
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
import {
  ARCHIVE_ADMIN_ALERT_OUTBOX,
  type ArchiveAdminAlertStateLockPort,
  type ArchiveAdminAlertOutboxPort,
} from './application/ports/archive-admin-alert-outbox.port';
import { ARCHIVE_REGISTRATION } from './application/ports/archive-registration.port';
import { ARCHIVE_REGISTRATION_LOOKUP } from './application/ports/archive-registration-lookup.port';
import { ARCHIVE_RUNTIME_SIGNAL } from './application/ports/archive-runtime-signal.port';
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
import {
  DRIVE_FOLDER,
  type DriveFolderPort,
} from './application/ports/drive-folder.port';
import {
  DRIVE_FOLDER_RESERVATION_REPOSITORY,
  type DriveFolderReservationRepositoryPort,
} from './application/ports/drive-folder-reservation-repository.port';
import {
  ARCHIVE_PROVIDER_STATE_REPOSITORY,
  type ArchiveProviderStateRepositoryPort,
  type ArchiveProviderStateTransactionPort,
} from './application/ports/archive-provider-state-repository.port';
import {
  DRIVE_QUOTA_PROBE,
  type DriveQuotaProbePort,
} from './application/ports/drive-quota-probe.port';
import { BeginDriveConnectionUseCase } from './application/use-cases/begin-drive-connection.use-case';
import { CancelDriveConnectionUseCase } from './application/use-cases/cancel-drive-connection.use-case';
import { ConfirmDriveAccountUseCase } from './application/use-cases/confirm-drive-account.use-case';
import { CreateDatabaseBackupUseCase } from './application/use-cases/create-database-backup.use-case';
import { DisconnectDriveUseCase } from './application/use-cases/disconnect-drive.use-case';
import { RegisterArchiveArtifactUseCase } from './application/use-cases/register-archive-artifact.use-case';
import { FindRegisteredArchiveArtifactUseCase } from './application/use-cases/find-registered-archive-artifact.use-case';
import { ReconcileDriveUseCase } from './application/use-cases/reconcile-drive.use-case';
import { RetireDriveConnectionUseCase } from './application/use-cases/retire-drive-connection.use-case';
import { ReportDriveStatusUseCase } from './application/use-cases/report-drive-status.use-case';
import { SubmitDriveClientUseCase } from './application/use-cases/submit-drive-client.use-case';
import { VerifyArchiveArtifactUseCase } from './application/use-cases/verify-archive-artifact.use-case';
import { ApplyDriveRetentionUseCase } from './application/use-cases/apply-drive-retention.use-case';
import { ResolveMotionArchiveContainerUseCase } from './application/use-cases/resolve-motion-archive-container.use-case';
import { ProbeDriveQuotaRecoveryUseCase } from './application/use-cases/probe-drive-quota-recovery.use-case';
import { RetryDriveArchiveUseCase } from './application/use-cases/retry-drive-archive.use-case';
import { DriveClockUnhealthyError } from './domain/errors/drive-clock-unhealthy.error';
import {
  ARCHIVE_UPLOAD_SOURCE,
  UploadDriveObjectAttemptUseCase,
  type ArchiveUploadSourcePort,
} from './application/use-cases/upload-drive-object-attempt.use-case';
import { GoogleDeviceAuthorizationAdapter } from './infrastructure/google/google-device-authorization.adapter';
import { GoogleDriveArchiveAdapter } from './infrastructure/google/google-drive-archive.adapter';
import { GoogleDriveConnectionAccountAdapter } from './infrastructure/google/google-drive-connection-account.adapter';
import { GoogleDriveFolderAdapter } from './infrastructure/google/google-drive-folder.adapter';
import { AesGcmArchiveSecretAdapter } from './infrastructure/persistence/aes-gcm-archive-secret.adapter';
import { DrizzleArchiveArtifactRepository } from './infrastructure/persistence/drizzle-archive-artifact.repository';
import { DrizzleDriveCredentialRepository } from './infrastructure/persistence/drizzle-drive-credential.repository';
import { FsArchiveUploadSourceAdapter } from './infrastructure/persistence/fs-archive-upload-source.adapter';
import { DurableArchiveAdminAlertAdapter } from './infrastructure/events/durable-archive-admin-alert.adapter';
import { DrizzleArchiveAdminAlertOutboxAdapter } from './infrastructure/events/drizzle-archive-admin-alert-outbox.adapter';
import { SharedStateArchiveAdminAlertOutboxAdapter } from './infrastructure/events/shared-state-archive-admin-alert-outbox.adapter';
import { InMemoryArchiveArtifactRepository } from './infrastructure/persistence/in-memory-archive-artifact.repository';
import { InMemoryDriveCredentialRepository } from './infrastructure/persistence/in-memory-drive-credential.repository';
import { DrizzleDriveFolderReservationRepository } from './infrastructure/persistence/drizzle-drive-folder-reservation.repository';
import { InMemoryDriveFolderReservationRepository } from './infrastructure/persistence/in-memory-drive-folder-reservation.repository';
import { DrizzleArchiveProviderStateRepository } from './infrastructure/persistence/drizzle-archive-provider-state.repository';
import { InMemoryArchiveProviderStateRepository } from './infrastructure/persistence/in-memory-archive-provider-state.repository';
import { SystemArchiveClockAdapter } from './infrastructure/system-archive-clock.adapter';
import { archiveSchedulerOptionsFromConfig } from './infrastructure/archive-scheduler-options.adapter';

const ARCHIVE_BOOT_RECOVERY_REGISTRATION = Symbol('ARCHIVE_BOOT_RECOVERY_REGISTRATION');
const ARCHIVE_REMOTE_MAINTENANCE_REGISTRATION = Symbol('ARCHIVE_REMOTE_MAINTENANCE_REGISTRATION');
const ARCHIVE_SCHEDULER_OPTIONS = Symbol('ARCHIVE_SCHEDULER_OPTIONS');
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
    archiveMode === 'memory'
      ? InMemoryDriveFolderReservationRepository
      : DrizzleDriveFolderReservationRepository,
    {
      provide: DRIVE_FOLDER_RESERVATION_REPOSITORY,
      useExisting: archiveMode === 'memory'
        ? InMemoryDriveFolderReservationRepository
        : DrizzleDriveFolderReservationRepository,
    },
    archiveMode === 'memory'
      ? InMemoryArchiveProviderStateRepository
      : DrizzleArchiveProviderStateRepository,
    {
      provide: ARCHIVE_PROVIDER_STATE_REPOSITORY,
      useExisting: archiveMode === 'memory'
        ? InMemoryArchiveProviderStateRepository
        : DrizzleArchiveProviderStateRepository,
    },
    archiveMode === 'memory'
      ? {
        provide: InMemoryArchiveArtifactRepository,
        useFactory: (reservations: DriveFolderReservationRepositoryPort) =>
          new InMemoryArchiveArtifactRepository(
            reservations as InMemoryDriveFolderReservationRepository,
          ),
        inject: [DRIVE_FOLDER_RESERVATION_REPOSITORY],
      }
      : DrizzleArchiveArtifactRepository,
    {
      provide: ARCHIVE_ARTIFACT_REPOSITORY,
      useExisting: archiveMode === 'memory'
        ? InMemoryArchiveArtifactRepository
        : DrizzleArchiveArtifactRepository,
    },
    ArchiveWakeService,
    {
      provide: ARCHIVE_SCHEDULER_OPTIONS,
      useFactory: () => archiveSchedulerOptionsFromConfig(loadDefaults().archive, process.env),
    },
    {
      provide: ArchiveProviderGateService,
      useFactory: (
        state: ArchiveProviderStateRepositoryPort,
        clock: ClockPort,
        options: ArchiveSchedulerOptions,
        outbox: ArchiveAdminAlertOutboxPort,
        credentials: DriveCredentialRepositoryPort,
      ) => new ArchiveProviderGateService(
        state,
        clock,
        undefined,
        undefined,
        { maximumSleepMs: options.intervalMs },
        outbox,
        credentials,
      ),
      inject: [
        ARCHIVE_PROVIDER_STATE_REPOSITORY,
        CLOCK,
        ARCHIVE_SCHEDULER_OPTIONS,
        ARCHIVE_ADMIN_ALERT_OUTBOX,
        DRIVE_CREDENTIAL_REPOSITORY,
      ],
    },
    {
      provide: RegisterArchiveArtifactUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        clock: ClockPort,
        wake: ArchiveWakeService,
      ) => new RegisterArchiveArtifactUseCase(repository, clock, wake),
      inject: [ARCHIVE_ARTIFACT_REPOSITORY, CLOCK, ArchiveWakeService],
    },
    { provide: ARCHIVE_REGISTRATION, useExisting: RegisterArchiveArtifactUseCase },
    FindRegisteredArchiveArtifactUseCase,
    {
      provide: ARCHIVE_REGISTRATION_LOOKUP,
      useExisting: FindRegisteredArchiveArtifactUseCase,
    },
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
    { provide: DRIVE_QUOTA_PROBE, useExisting: GoogleDriveConnectionAccountAdapter },
    {
      provide: DRIVE_ACCOUNT,
      useFactory: (
        account: GoogleDriveConnectionAccountAdapter,
        gate: ArchiveProviderGateService,
      ): DriveAccountPort => ({
        resolveAccount: (connection, signal) => account.resolveAccount(connection, signal),
        resolveManagedFolders: (connection, signal) =>
          account.resolveManagedFolders(connection, signal),
        readQuota: (connection, signal) => gate.run({
          generationId: connection.id,
          operationClass: 'account',
          probe: true,
          operation: () => account.readQuota(connection, signal),
          signal,
        }),
      }),
      inject: [GoogleDriveConnectionAccountAdapter, ArchiveProviderGateService],
    },
    GoogleDriveFolderAdapter,
    { provide: DRIVE_FOLDER, useExisting: GoogleDriveFolderAdapter },
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
    archiveMode === 'memory'
      ? {
        provide: SharedStateArchiveAdminAlertOutboxAdapter,
        useFactory: (
          credentials: DriveCredentialRepositoryPort & ArchiveAdminAlertStateLockPort,
          events: EventRepositoryPort,
          providerState: ArchiveProviderStateRepositoryPort
            & ArchiveProviderStateTransactionPort,
        ) => new SharedStateArchiveAdminAlertOutboxAdapter(
          credentials,
          events,
          providerState,
        ),
        inject: [
          DRIVE_CREDENTIAL_REPOSITORY,
          EVENT_REPOSITORY,
          ARCHIVE_PROVIDER_STATE_REPOSITORY,
        ],
      }
      : {
        provide: DrizzleArchiveAdminAlertOutboxAdapter,
        useFactory: (db: AppDatabase, options: EventQueueOptions) =>
          new DrizzleArchiveAdminAlertOutboxAdapter(db, options),
        inject: [DB, EVENT_QUEUE_OPTIONS],
      },
    {
      provide: ARCHIVE_ADMIN_ALERT_OUTBOX,
      useExisting: archiveMode === 'memory'
        ? SharedStateArchiveAdminAlertOutboxAdapter
        : DrizzleArchiveAdminAlertOutboxAdapter,
    },
    {
      provide: DurableArchiveAdminAlertAdapter,
      useFactory: (
        outbox: ArchiveAdminAlertOutboxPort,
        alerts: ArchiveAdminAlertService,
        clock: ClockPort,
        notifications: NotificationService,
      ) => new DurableArchiveAdminAlertAdapter(outbox, alerts, clock, notifications),
      inject: [ARCHIVE_ADMIN_ALERT_OUTBOX, ArchiveAdminAlertService, CLOCK, NotificationService],
    },
    { provide: ARCHIVE_ADMIN_ALERT, useExisting: DurableArchiveAdminAlertAdapter },
    {
      provide: ProbeDriveQuotaRecoveryUseCase,
      useFactory: (
        artifacts: ArchiveArtifactRepositoryPort,
        quota: DriveQuotaProbePort,
        gate: ArchiveProviderGateService,
        clock: ClockPort,
      ) => new ProbeDriveQuotaRecoveryUseCase(artifacts, quota, gate, clock),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_QUOTA_PROBE,
        ArchiveProviderGateService,
        CLOCK,
      ],
    },
    {
      provide: RetryDriveArchiveUseCase,
      useFactory: (
        providerState: ArchiveProviderStateRepositoryPort,
        reservations: DriveFolderReservationRepositoryPort,
        clock: ClockPort,
        wake: ArchiveWakeService,
      ) => new RetryDriveArchiveUseCase(providerState, reservations, clock, wake),
      inject: [
        ARCHIVE_PROVIDER_STATE_REPOSITORY,
        DRIVE_FOLDER_RESERVATION_REPOSITORY,
        CLOCK,
        ArchiveWakeService,
      ],
    },
    {
      provide: ResolveMotionArchiveContainerUseCase,
      useFactory: (
        drive: DriveFolderPort,
        reservations: DriveFolderReservationRepositoryPort,
        lock: ArchiveRemoteMutationLockService,
        alerts: ArchiveAdminAlertPort,
        gate: ArchiveProviderGateService,
      ) => {
        const resolver = new ResolveMotionArchiveContainerUseCase(
          drive,
          reservations,
          lock,
          alerts,
        );
        return {
          execute: (
            ...args: Parameters<ResolveMotionArchiveContainerUseCase['execute']>
          ) => gate.run({
            generationId: args[0].id,
            operationClass: 'folder',
            probe: true,
            operation: () => resolver.execute(...args),
            signal: args[2],
          }),
        } satisfies Pick<ResolveMotionArchiveContainerUseCase, 'execute'>;
      },
      inject: [
        DRIVE_FOLDER,
        DRIVE_FOLDER_RESERVATION_REPOSITORY,
        ArchiveRemoteMutationLockService,
        ARCHIVE_ADMIN_ALERT,
        ArchiveProviderGateService,
      ],
    },
    {
      provide: ReportDriveStatusUseCase,
      useFactory: (
        credentials: DriveCredentialRepositoryPort,
        repository: ArchiveArtifactRepositoryPort,
        account: DriveAccountPort,
        providerState: ArchiveProviderStateRepositoryPort,
        clock: ClockPort,
        scheduler: ArchiveSchedulerService,
      ) => new ReportDriveStatusUseCase(
        credentials,
        repository,
        account,
        providerState,
        clock,
        scheduler,
      ),
      inject: [
        DRIVE_CREDENTIAL_REPOSITORY,
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_ACCOUNT,
        ARCHIVE_PROVIDER_STATE_REPOSITORY,
        CLOCK,
        ArchiveSchedulerService,
      ],
    },
    {
      provide: VerifyArchiveArtifactUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        credentials: DriveCredentialRepositoryPort,
        drive: DriveArchivePort,
        source: ArchiveUploadSourcePort,
        lock: ArchiveRemoteMutationLockService,
        gate: ArchiveProviderGateService,
      ) => new VerifyArchiveArtifactUseCase(
        repository,
        credentials,
        drive,
        source,
        lock,
        gate,
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ARCHIVE,
        ARCHIVE_UPLOAD_SOURCE,
        ArchiveRemoteMutationLockService,
        ArchiveProviderGateService,
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
        resolver: Pick<ResolveMotionArchiveContainerUseCase, 'execute'>,
      ) => new ReconcileDriveUseCase(
        repository,
        credentials,
        drive,
        source,
        alerts,
        resolver,
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ARCHIVE,
        ARCHIVE_UPLOAD_SOURCE,
        ARCHIVE_ADMIN_ALERT,
        ResolveMotionArchiveContainerUseCase,
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
        GoogleDriveConnectionAccountAdapter,
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
        account: GoogleDriveConnectionAccountAdapter,
        clock: ClockPort,
        wake: ArchiveWakeService,
        lock: ArchiveRemoteMutationLockService,
        gate: ArchiveProviderGateService,
      ) => new ConfirmDriveAccountUseCase(
        credentials,
        account,
        clock,
        wake,
        lock,
        gate,
      ),
      inject: [
        DRIVE_CREDENTIAL_REPOSITORY,
        GoogleDriveConnectionAccountAdapter,
        CLOCK,
        ArchiveWakeService,
        ArchiveRemoteMutationLockService,
        ArchiveProviderGateService,
      ],
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
        lock: ArchiveRemoteMutationLockService,
      ) => new RetireDriveConnectionUseCase(credentials, authorization, clock, lock),
      inject: [
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_DEVICE_AUTHORIZATION,
        CLOCK,
        ArchiveRemoteMutationLockService,
      ],
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
        resolver: Pick<ResolveMotionArchiveContainerUseCase, 'execute'>,
        activityGate: ArchiveRemoteMutationLockService,
        providerGate: ArchiveProviderGateService,
      ) => new UploadDriveObjectAttemptUseCase(
        repository,
        credentials,
        drive,
        cipher,
        source,
        semaphore,
        resolver,
        { activityGate, providerGate },
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        DRIVE_ARCHIVE,
        ARCHIVE_SECRET_CIPHER,
        ARCHIVE_UPLOAD_SOURCE,
        ArchiveTransferSemaphoreService,
        ResolveMotionArchiveContainerUseCase,
        ArchiveRemoteMutationLockService,
        ArchiveProviderGateService,
      ],
    },
    {
      provide: ApplyDriveRetentionUseCase,
      useFactory: (
        repository: ArchiveArtifactRepositoryPort,
        credentials: DriveCredentialRepositoryPort,
        account: GoogleDriveConnectionAccountAdapter,
        drive: DriveArchivePort,
        source: ArchiveUploadSourcePort,
        clock: ArchiveClockPort,
        lock: ArchiveRemoteMutationLockService,
        gate: ArchiveProviderGateService,
      ) => {
        const retention = new ApplyDriveRetentionUseCase(
          repository,
          credentials,
          account,
          drive,
          source,
          clock,
          lock,
        );
        return {
          execute: async (
            ...args: Parameters<ApplyDriveRetentionUseCase['execute']>
          ) => {
            const active = await credentials.loadActive();
            if (active?.status !== 'active') return retention.execute(...args);
            return gate.run({
              generationId: active.id,
              operationClass: 'delete',
              probe: true,
              operation: () => retention.execute(...args),
              signal: args[1],
            });
          },
        } satisfies ArchiveRetentionPort;
      },
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        DRIVE_CREDENTIAL_REPOSITORY,
        GoogleDriveConnectionAccountAdapter,
        DRIVE_ARCHIVE,
        ARCHIVE_UPLOAD_SOURCE,
        ARCHIVE_CLOCK,
        ArchiveRemoteMutationLockService,
        ArchiveProviderGateService,
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
        options: ArchiveSchedulerOptions,
        wake: ArchiveWakeService,
        providerGate: ArchiveProviderGateService,
        credentials: DriveCredentialRepositoryPort,
        providerState: ArchiveProviderStateRepositoryPort,
        alerts: ArchiveAdminAlertPort,
        health: SystemHealthPort,
      ) => new ArchiveSchedulerService(
        repository,
        backups,
        uploads,
        hooks,
        lock,
        retention,
        clock,
        options,
        wake,
        providerGate,
        credentials,
        providerState,
        alerts,
        {
          usagePercent: async () => {
            const snapshot = await health.collect();
            if (snapshot.diskUsedBytes === null
              || snapshot.diskTotalBytes === null
              || snapshot.diskTotalBytes <= 0) return Number.NaN;
            return (snapshot.diskUsedBytes / snapshot.diskTotalBytes) * 100;
          },
        },
      ),
      inject: [
        ARCHIVE_ARTIFACT_REPOSITORY,
        CreateDatabaseBackupUseCase,
        UploadDriveObjectAttemptUseCase,
        ArchiveSchedulerHooksService,
        ArchiveRemoteMutationLockService,
        ARCHIVE_RETENTION,
        CLOCK,
        ARCHIVE_SCHEDULER_OPTIONS,
        ArchiveWakeService,
        ArchiveProviderGateService,
        DRIVE_CREDENTIAL_REPOSITORY,
        ARCHIVE_PROVIDER_STATE_REPOSITORY,
        ARCHIVE_ADMIN_ALERT,
        SYSTEM_HEALTH,
      ],
    },
    { provide: ARCHIVE_RUNTIME_SIGNAL, useExisting: ArchiveSchedulerService },
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
        wake: ArchiveWakeService,
      ) => new ArchiveRuntimeLifecycleService(
        credentials, repository, retire, polling, snapshots, backups,
        scheduler, hooks, clock, lock, wake,
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
        ArchiveWakeService,
      ],
    },
    {
      provide: ARCHIVE_REMOTE_MAINTENANCE_REGISTRATION,
      useFactory: (
        hooks: ArchiveSchedulerHooksService,
        reconcile: ReconcileDriveUseCase,
        retention: ArchiveRetentionPort,
        alerts: ArchiveAdminAlertPort,
        credentials: DriveCredentialRepositoryPort,
        gate: ArchiveProviderGateService,
        sharedLock: ArchiveRemoteMutationLockService,
      ) => {
        hooks.registerRemoteMaintenance(async (_lock, signal) => {
          const active = await sharedLock.runExclusive(async () => {
            const current = await credentials.loadActive();
            if (current?.status === 'active') await gate.ensureGeneration(current.id);
            return current;
          });
          const reconcileOperation = () => reconcile.execute({ limit: 20 }, signal, sharedLock);
          if (active?.status === 'active') {
            await gate.run({
              generationId: active.id,
              operationClass: 'reconcile',
              probe: true,
              operation: reconcileOperation,
              signal,
            });
          } else {
            await reconcileOperation();
          }
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
        DRIVE_CREDENTIAL_REPOSITORY,
        ArchiveProviderGateService,
        ArchiveRemoteMutationLockService,
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
    ARCHIVE_REGISTRATION,
    ARCHIVE_REGISTRATION_LOOKUP,
    ARCHIVE_RUNTIME_SIGNAL,
    ARCHIVE_VERIFICATION,
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
    ProbeDriveQuotaRecoveryUseCase,
    RetryDriveArchiveUseCase,
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
