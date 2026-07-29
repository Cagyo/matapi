import { Module } from '@nestjs/common';
import { EventModule } from '../events/event.module';
import { ARCHIVE_ARTIFACT_REPOSITORY } from './application/ports/archive-artifact-repository.port';
import { ARCHIVE_SECRET_CIPHER } from './application/ports/archive-secret-cipher.port';
import { DRIVE_ACCOUNT } from './application/ports/drive-account.port';
import { DRIVE_CREDENTIAL_REPOSITORY } from './application/ports/drive-credential-repository.port';
import { DRIVE_DEVICE_AUTHORIZATION } from './application/ports/drive-device-authorization.port';
import { GoogleDriveConnectionAccountAdapter } from './infrastructure/google/google-drive-connection-account.adapter';
import { GoogleDeviceAuthorizationAdapter } from './infrastructure/google/google-device-authorization.adapter';
import { AesGcmArchiveSecretAdapter } from './infrastructure/persistence/aes-gcm-archive-secret.adapter';
import { DrizzleArchiveArtifactRepository } from './infrastructure/persistence/drizzle-archive-artifact.repository';
import { DrizzleDriveCredentialRepository } from './infrastructure/persistence/drizzle-drive-credential.repository';

/** Archive-owned provider bindings consumed through ports by Telegram and later schedulers. */
@Module({
  imports: [EventModule],
  providers: [
    { provide: ARCHIVE_SECRET_CIPHER, useFactory: () => new AesGcmArchiveSecretAdapter(process.env.HOME_WORKER_ARCHIVE_KEY_PATH ?? '/etc/home-worker/archive.key') },
    DrizzleDriveCredentialRepository,
    { provide: DRIVE_CREDENTIAL_REPOSITORY, useExisting: DrizzleDriveCredentialRepository },
    DrizzleArchiveArtifactRepository,
    { provide: ARCHIVE_ARTIFACT_REPOSITORY, useExisting: DrizzleArchiveArtifactRepository },
    { provide: DRIVE_DEVICE_AUTHORIZATION, useClass: GoogleDeviceAuthorizationAdapter },
    GoogleDriveConnectionAccountAdapter,
    { provide: DRIVE_ACCOUNT, useExisting: GoogleDriveConnectionAccountAdapter },
  ],
  exports: [DRIVE_CREDENTIAL_REPOSITORY, ARCHIVE_ARTIFACT_REPOSITORY, DRIVE_DEVICE_AUTHORIZATION, DRIVE_ACCOUNT],
})
export class ArchiveModule {}
